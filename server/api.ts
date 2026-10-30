// REST API for sessions. Storage is one JSON file per session; the solver runs in the host's browser.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import express, { type Request, type Response, type NextFunction } from 'express'
import { isDate } from '../src/shared/dates.ts'
import type {
  Assignment,
  Concern,
  Member,
  MemberResponse,
  PublicSession,
  Schedule,
  SessionConfig,
  ShiftSlot,
} from '../src/shared/types.ts'
import { randomCode } from './words.ts'

interface StoredSession extends Omit<PublicSession, 'claimed'> {
  hostToken: string
  auth: Record<string, { salt: string; hash: string; tokens: string[] }>
}

const token = () => randomBytes(24).toString('base64url')
const id = () => randomBytes(6).toString('base64url')
const hashPin = (pin: string, salt: string) => scryptSync(pin, salt, 32).toString('hex')

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---------- input cleaning ----------

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '')
const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : [])
const time = (v: unknown) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : '08:00')

function cleanConfig(raw: unknown): SessionConfig {
  const c = (raw ?? {}) as Record<string, unknown>
  const jobs = arr(c.jobs, 30).map((j) => {
    const o = j as Record<string, unknown>
    return { id: str(o.id, 40) || id(), name: str(o.name, 60) || 'Job' }
  })
  const jobIds = new Set(jobs.map((j) => j.id))
  const shifts: ShiftSlot[] = arr(c.shifts, 12).map((s) => {
    const o = s as Record<string, unknown>
    return {
      id: str(o.id, 40) || id(),
      name: str(o.name, 60) || 'Shift',
      start: time(o.start),
      end: time(o.end),
      days: [...new Set(arr(o.days, 7).map((d) => int(d, 0, 6, 0)))],
      requirements: arr(o.requirements, 20)
        .map((r) => {
          const q = r as Record<string, unknown>
          const memberType: 'resident' | 'staff' | 'any' =
            q.memberType === 'resident' || q.memberType === 'staff' ? q.memberType : 'any'
          return { id: str(q.id, 40) || id(), jobId: str(q.jobId, 40), memberType, count: int(q.count, 1, 20, 1) }
        })
        .filter((r) => jobIds.has(r.jobId)),
    }
  })
  const members: Member[] = arr(c.members, 100).map((m) => {
    const o = m as Record<string, unknown>
    const max = o.maxShifts === undefined || o.maxShifts === null || o.maxShifts === '' ? undefined : int(o.maxShifts, 0, 400, 0)
    return {
      id: str(o.id, 40) || id(),
      name: str(o.name, 60) || 'Member',
      type: o.type === 'staff' ? 'staff' : 'resident',
      jobs: arr(o.jobs, 30).map((j) => str(j, 40)).filter((j) => jobIds.has(j)),
      ...(max === undefined ? {} : { maxShifts: max }),
    }
  })
  let startDate = isDate(c.startDate) ? c.startDate : new Date().toISOString().slice(0, 10)
  let endDate = isDate(c.endDate) ? c.endDate : startDate
  if (endDate < startDate) [startDate, endDate] = [endDate, startDate]
  return {
    title: str(c.title, 100) || 'Untitled roster',
    startDate,
    endDate,
    holidays: arr(c.holidays, 100).filter(isDate),
    jobs,
    shifts,
    members,
    extraConditions: str(c.extraConditions, 5000),
  }
}

function cleanResponse(raw: unknown): MemberResponse {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    preference: r.preference === 'dense' ? 'dense' : 'distributed',
    minInterval: int(r.minInterval, 1, 60, 2),
    unavailable: [...new Set(arr(r.unavailable, 400).filter(isDate))],
    locks: arr(r.locks, 200)
      .map((l) => l as Record<string, unknown>)
      .filter((l) => isDate(l.date))
      .map((l) => ({ date: l.date as string, shiftId: str(l.shiftId, 40) })),
    note: str(r.note, 1000),
    updatedAt: Date.now(),
  }
}

function cleanSchedule(raw: unknown): Schedule | null {
  if (raw === null) return null
  const s = (raw ?? {}) as Record<string, unknown>
  const assignments: Assignment[] = arr(s.assignments, 20_000).map((a) => {
    const o = a as Record<string, unknown>
    return { date: str(o.date, 10), shiftId: str(o.shiftId, 40), requirementId: str(o.requirementId, 40), memberId: str(o.memberId, 40) }
  })
  return {
    status: s.status === 'final' ? 'final' : 'review',
    assignments,
    generatedAt: int(s.generatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    reviewUntil: int(s.reviewUntil, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    source: s.source === 'ai' || s.source === 'manual' ? s.source : 'solver',
  }
}

// ---------- storage ----------

export function createApi(dataDir: string) {
  const dir = join(dataDir, 'sessions')
  mkdirSync(dir, { recursive: true })
  const cache = new Map<string, StoredSession>()
  const file = (code: string) => join(dir, `${code}.json`)

  function load(code: string): StoredSession {
    if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(code)) throw new HttpError(404, 'Session not found')
    let s = cache.get(code)
    if (!s && existsSync(file(code))) {
      s = JSON.parse(readFileSync(file(code), 'utf8')) as StoredSession
      cache.set(code, s)
    }
    if (!s) throw new HttpError(404, 'Session not found')
    return s
  }

  function save(s: StoredSession) {
    s.version++
    cache.set(s.code, s)
    const tmp = `${file(s.code)}.tmp`
    writeFileSync(tmp, JSON.stringify(s))
    renameSync(tmp, file(s.code))
  }

  function toPublic(s: StoredSession): PublicSession {
    const { hostToken: _h, auth, ...rest } = s
    return { ...rest, claimed: Object.keys(auth) }
  }

  function who(req: Request, s: StoredSession) {
    const t = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const tokens = t ? t.split(',') : []
    const isHost = tokens.some((x) => safeEqual(x, s.hostToken))
    const memberId = Object.entries(s.auth).find(([, a]) => a.tokens.some((x) => tokens.some((y) => safeEqual(x, y))))?.[0] ?? null
    return { isHost, memberId }
  }

  const router = express.Router()
  router.use(express.json({ limit: '2mb' }))

  const handle =
    (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
      try {
        const out = fn(req, res)
        if (out !== undefined) res.json(out)
      } catch (e) {
        next(e)
      }
    }

  const view = (req: Request, s: StoredSession) => ({ session: toPublic(s), me: who(req, s) })

  router.post(
    '/sessions',
    handle((req) => {
      let code = randomCode()
      for (let i = 0; i < 20 && (cache.has(code) || existsSync(file(code))); i++) code = randomCode()
      const today = new Date().toISOString().slice(0, 10)
      const s: StoredSession = {
        code,
        createdAt: Date.now(),
        version: 0,
        hostToken: token(),
        auth: {},
        config: cleanConfig({ title: (req.body as { title?: string })?.title, startDate: today, endDate: today }),
        responses: {},
        schedule: null,
        concerns: [],
      }
      save(s)
      return { code, hostToken: s.hostToken }
    }),
  )

  router.get(
    '/sessions/:code',
    handle((req) => view(req, load(String(req.params.code)))),
  )

  router.put(
    '/sessions/:code/config',
    handle((req) => {
      const s = load(String(req.params.code))
      if (!who(req, s).isHost) throw new HttpError(403, 'Only the host can edit the setup')
      s.config = cleanConfig(req.body)
      const ids = new Set(s.config.members.map((m) => m.id))
      for (const k of Object.keys(s.responses)) if (!ids.has(k)) delete s.responses[k]
      for (const k of Object.keys(s.auth)) if (!ids.has(k)) delete s.auth[k]
      save(s)
      return view(req, s)
    }),
  )

  router.post(
    '/sessions/:code/claim',
    handle((req) => {
      const s = load(String(req.params.code))
      const body = (req.body ?? {}) as { memberId?: string; pin?: string }
      const memberId = str(body.memberId, 40)
      const pin = str(body.pin, 20)
      if (!s.config.members.some((m) => m.id === memberId)) throw new HttpError(404, 'No such member')
      if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'PIN must be 4–8 digits')
      const existing = s.auth[memberId]
      if (existing) {
        if (!safeEqual(hashPin(pin, existing.salt), existing.hash)) throw new HttpError(401, 'Wrong PIN for this name')
      } else {
        const salt = randomBytes(8).toString('hex')
        s.auth[memberId] = { salt, hash: hashPin(pin, salt), tokens: [] }
      }
      const t = token()
      s.auth[memberId].tokens = [...s.auth[memberId].tokens.slice(-9), t]
      save(s)
      return { memberToken: t }
    }),
  )

  router.delete(
    '/sessions/:code/claim/:memberId',
    handle((req) => {
      const s = load(String(req.params.code))
      if (!who(req, s).isHost) throw new HttpError(403, 'Only the host can reset a login')
      delete s.auth[String(req.params.memberId)]
      save(s)
      return view(req, s)
    }),
  )

  router.put(
    '/sessions/:code/responses/:memberId',
    handle((req) => {
      const s = load(String(req.params.code))
      const memberId = String(req.params.memberId)
      const me = who(req, s)
      if (!me.isHost && me.memberId !== memberId) throw new HttpError(403, 'You can only edit your own answers')
      if (!s.config.members.some((m) => m.id === memberId)) throw new HttpError(404, 'No such member')
      if (s.schedule?.status === 'final' && !me.isHost) throw new HttpError(409, 'The roster is final')
      s.responses[memberId] = cleanResponse(req.body)
      save(s)
      return view(req, s)
    }),
  )

  router.put(
    '/sessions/:code/schedule',
    handle((req) => {
      const s = load(String(req.params.code))
      if (!who(req, s).isHost) throw new HttpError(403, 'Only the host can publish a roster')
      s.schedule = cleanSchedule(req.body)
      save(s)
      return view(req, s)
    }),
  )

  router.post(
    '/sessions/:code/concerns',
    handle((req) => {
      const s = load(String(req.params.code))
      const me = who(req, s)
      if (!me.memberId && !me.isHost) throw new HttpError(401, 'Log in to post a concern')
      if (!me.isHost && (!s.schedule || s.schedule.status !== 'review' || Date.now() > s.schedule.reviewUntil)) {
        throw new HttpError(409, 'The concern period is closed')
      }
      const b = (req.body ?? {}) as Record<string, unknown>
      const text = str(b.text, 1000).trim()
      if (!text) throw new HttpError(400, 'Write something first')
      const concern: Concern = {
        id: id(),
        memberId: me.memberId ?? 'host',
        text,
        ...(isDate(b.date) ? { date: b.date } : {}),
        ...(typeof b.shiftId === 'string' && b.shiftId ? { shiftId: str(b.shiftId, 40) } : {}),
        createdAt: Date.now(),
        resolved: false,
      }
      s.concerns = [...s.concerns.slice(-499), concern]
      save(s)
      return view(req, s)
    }),
  )

  router.patch(
    '/sessions/:code/concerns/:id',
    handle((req) => {
      const s = load(String(req.params.code))
      if (!who(req, s).isHost) throw new HttpError(403, 'Only the host can resolve concerns')
      const c = s.concerns.find((x) => x.id === req.params.id)
      if (!c) throw new HttpError(404, 'No such concern')
      c.resolved = Boolean((req.body as { resolved?: boolean })?.resolved)
      save(s)
      return view(req, s)
    }),
  )

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) console.error(err)
    res.status(status).json({ error: err instanceof Error && status !== 500 ? err.message : 'Server error' })
  })

  return router
}
