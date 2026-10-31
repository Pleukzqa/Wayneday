// REST API for sessions. Sessions are stored by a Store (Postgres or JSON files); the solver runs in the host's browser.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import express, { type Request, type Response, type NextFunction } from 'express'
import { isDate } from '../src/shared/dates.ts'
import { actOnSwap, createJoin, decideJoin, OpError, requestSwap, saveResponse, type SwapAction } from '../src/shared/ops.ts'
import {
  ANY_SHIFT,
  DEFAULT_STUDENTS,
  normalizeSession,
  type Assignment,
  type Concern,
  type DateOverride,
  type DaysBack,
  type Member,
  type MemberResponse,
  type MemberType,
  type PlacePeriod,
  type PresentationOverride,
  type PresentationRule,
  type PresenterAssignment,
  type PublicSession,
  type Schedule,
  type SessionConfig,
  type ShiftSlot,
  type StudentAssignment,
} from '../src/shared/types.ts'
import { accountTokens, googleVerifier, isEmail, normEmail, secretFromEnv, type Account, type GoogleVerify } from './auth.ts'
import { Limiter } from './limit.ts'
import type { Store } from './store.ts'
import { randomCode } from './words.ts'

export interface HostEntry {
  email: string
  name: string
  role: 'owner' | 'cohost'
  addedAt: number
}

interface StoredSession extends PublicSession {
  hostToken: string
  /** Google accounts that can run this session; empty for sessions made before sign-in existed. */
  hosts: HostEntry[]
  auth: Record<string, { salt: string; hash: string; tokens: string[] }>
  /** Join request id -> credentials that become the member's login once the host approves. */
  pendingAuth: Record<string, { salt: string; hash: string; token: string }>
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
/** A number like 2.5, rounded to hundredths. */
const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : fallback
}
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : [])
const memberType = (v: unknown): MemberType => (v === 'staff' || v === 'student' ? v : 'resident')
/** [nearest, farthest] days back, 1–7; undefined when not given. */
const daysBack = (v: unknown): DaysBack | undefined => {
  if (!Array.isArray(v) || v.length !== 2) return undefined
  const [a, b] = v.map((x) => int(x, 1, 7, 1))
  return [Math.min(a, b), Math.max(a, b)]
}
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
      ...(o.endDays === undefined || o.endDays === null ? {} : { endDays: int(o.endDays, 0, 3, 1) }),
      days: [...new Set(arr(o.days, 7).map((d) => int(d, 0, 6, 0)))],
      requirements: arr(o.requirements, 20)
        .map((r) => {
          const q = r as Record<string, unknown>
          const memberType: 'resident' | 'staff' | 'any' =
            q.memberType === 'resident' || q.memberType === 'staff' ? q.memberType : 'any'
          const count = int(q.count, 1, 20, 1)
          const min = q.min === undefined || q.min === null ? undefined : int(q.min, 0, count, 0)
          return { id: str(q.id, 40) || id(), jobId: str(q.jobId, 40), memberType, count, ...(min === undefined ? {} : { min }) }
        })
        .filter((r) => !r.jobId || jobIds.has(r.jobId)),
    }
  })
  const members: Member[] = arr(c.members, 100).map((m) => {
    const o = m as Record<string, unknown>
    const max = o.maxShifts === undefined || o.maxShifts === null || o.maxShifts === '' ? undefined : int(o.maxShifts, 0, 400, 0)
    const periods: PlacePeriod[] = arr(o.periods, 30)
      .map((x) => x as Record<string, unknown>)
      .filter((p) => isDate(p.from) && isDate(p.to) && jobIds.has(str(p.jobId, 40)))
      .map((p) => {
        const [from, to] = [p.from as string, p.to as string].sort()
        return { jobId: str(p.jobId, 40), from, to }
      })
    return {
      id: str(o.id, 40) || id(),
      name: str(o.name, 60) || 'Member',
      type: memberType(o.type),
      jobs: arr(o.jobs, 30).map((j) => str(j, 40)).filter((j) => jobIds.has(j)),
      ...(max === undefined ? {} : { maxShifts: max }),
      ...(periods.length ? { periods } : {}),
    }
  })
  const shiftIds = new Set(shifts.map((s) => s.id))
  const overrides: DateOverride[] = arr(c.overrides, 2000)
    .map((x) => x as Record<string, unknown>)
    .filter((o) => isDate(o.date) && shiftIds.has(str(o.shiftId, 40)))
    .map((o) => {
      const counts = Object.fromEntries(
        Object.entries((o.counts ?? {}) as Record<string, unknown>).slice(0, 20).map(([k, v]) => [k.slice(0, 40), int(v, 0, 20, 0)]),
      )
      return { date: o.date as string, shiftId: str(o.shiftId, 40), active: Boolean(o.active), ...(Object.keys(counts).length ? { counts } : {}) }
    })
  const st = (c.students ?? {}) as Record<string, unknown>
  const students = {
    shiftIds: arr(st.shiftIds, 12).map((x) => str(x, 40)).filter((x) => shiftIds.has(x)),
    maxPerShift: int(st.maxPerShift, 1, 20, DEFAULT_STUDENTS.maxPerShift),
    shiftsPerStudent: int(st.shiftsPerStudent, 0, 100, DEFAULT_STUDENTS.shiftsPerStudent),
    auto: Boolean(st.auto),
    points: (() => {
      const p = (st.points ?? {}) as Record<string, unknown>
      return {
        on: Boolean(p.on),
        weekday: num(p.weekday, 0, 100, 1),
        weekend: num(p.weekend, 0, 100, 2),
        shifts: Object.fromEntries(
          Object.entries((p.shifts ?? {}) as Record<string, unknown>)
            .filter(([k]) => shiftIds.has(k))
            .map(([k, v]) => [k, num(v, 0, 100, 1)]),
        ),
      }
    })(),
    avoidRepeatResident: Boolean(st.avoidRepeatResident),
    avoidRepeatStaff: Boolean(st.avoidRepeatStaff),
    avoidRepeatPartner: Boolean(st.avoidRepeatPartner),
    wantPartner: Boolean(st.wantPartner),
    minGap: int(st.minGap, 0, 60, 0),
    perSlot: Object.fromEntries(
      Object.entries((st.perSlot ?? {}) as Record<string, unknown>)
        .filter(([k]) => shiftIds.has(k))
        .map(([k, v]) => [k, int(v, 0, 50, 0)]),
    ),
  }
  const presentations: PresentationRule[] = arr(c.presentations, 200).map((x) => {
    const o = x as Record<string, unknown>
    const count = int(o.count, 1, 20, 1)
    return {
      id: str(o.id, 40) || id(),
      name: str(o.name, 60) || 'Presentation',
      days: [...new Set(arr(o.days, 7).map((d) => int(d, 0, 6, 0)))],
      count,
      fromShiftId: o.fromShiftId === ANY_SHIFT || shiftIds.has(str(o.fromShiftId, 40)) ? str(o.fromShiftId, 40) : (shifts[0]?.id ?? ''),
      fromCount: int(o.fromCount, 0, count, 0),
      types: [...new Set(arr(o.types, 3).map(memberType))],
      ...(Array.isArray(o.dates) ? { dates: [...new Set(arr(o.dates, 400).filter(isDate))].sort() } : {}),
      ...(daysBack(o.daysBack) && String(daysBack(o.daysBack)) !== '1,1' ? { daysBack: daysBack(o.daysBack) } : {}),
      ...(Array.isArray(o.sources)
        ? {
            sources: arr(o.sources, 6)
              .map((x) => x as Record<string, unknown>)
              .filter((x) => x.shiftId === ANY_SHIFT || shiftIds.has(str(x.shiftId, 40)))
              .map((x) => {
                const shiftId = str(x.shiftId, 40)
                const placeId = str(x.placeId, 40)
                const placeOk = placeId && shifts.find((s) => s.id === shiftId)?.requirements.some((r) => r.id === placeId)
                const jobId = str(x.jobId, 40)
                return { shiftId, ...(placeOk ? { placeId } : {}), ...(jobIds.has(jobId) ? { jobId } : {}), count: int(x.count, 0, count, 1), when: x.when === 'same' ? ('same' as const) : ('before' as const) }
              }),
          }
        : {}),
    }
  })
  const ruleIds = new Set(presentations.map((r) => r.id))
  const presentationOverrides: PresentationOverride[] = arr(c.presentationOverrides, 2000)
    .map((x) => x as Record<string, unknown>)
    .filter((o) => isDate(o.date) && ruleIds.has(str(o.ruleId, 40)))
    .map((o) => ({
      date: o.date as string,
      ruleId: str(o.ruleId, 40),
      active: Boolean(o.active),
      ...(o.count === undefined ? {} : { count: int(o.count, 0, 20, 1) }),
      ...(o.fromCount === undefined ? {} : { fromCount: int(o.fromCount, 0, 20, 0) }),
      ...(daysBack(o.daysBack) ? { daysBack: daysBack(o.daysBack) } : {}),
    }))
  const memberIds = new Set(members.map((m) => m.id))
  const duty: Assignment[] = arr(c.duty, 20_000)
    .map((a) => a as Record<string, unknown>)
    .filter((o) => isDate(o.date) && shiftIds.has(str(o.shiftId, 40)) && memberIds.has(str(o.memberId, 40)))
    .map((o) => ({ date: o.date as string, shiftId: str(o.shiftId, 40), requirementId: str(o.requirementId, 40), memberId: str(o.memberId, 40) }))
  let startDate = isDate(c.startDate) ? c.startDate : new Date().toISOString().slice(0, 10)
  let endDate = isDate(c.endDate) ? c.endDate : startDate
  if (endDate < startDate) [startDate, endDate] = [endDate, startDate]
  return {
    title: str(c.title, 100) || 'Untitled roster',
    rosterMode: c.rosterMode === 'generate' ? 'generate' : 'hospital',
    duty,
    presentationOverrides,
    startDate,
    endDate,
    holidays: arr(c.holidays, 100).filter(isDate),
    jobs,
    shifts,
    overrides,
    members,
    students,
    presentations,
    extraConditions: str(c.extraConditions, 5000),
    datePoints: Object.fromEntries(
      Object.entries((c.datePoints ?? {}) as Record<string, unknown>)
        .slice(0, 2000)
        .filter(([d]) => isDate(d))
        .map(([d, v]) => [d, num(v, 0, 100, 1)]),
    ),
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
    avoid: arr(r.avoid, 400)
      .map((a) => a as Record<string, unknown>)
      .filter((a) => isDate(a.date))
      .map((a) => ({ date: a.date as string, level: int(a.level, 1, 3, 1) as 1 | 2 | 3 })),
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
  const students: StudentAssignment[] = arr(s.students, 20_000).map((a) => {
    const o = a as Record<string, unknown>
    const requirementId = str(o.requirementId, 40)
    return { date: str(o.date, 10), shiftId: str(o.shiftId, 40), ...(requirementId ? { requirementId } : {}), memberId: str(o.memberId, 40) }
  })
  const presenters: PresenterAssignment[] = arr(s.presenters, 20_000).map((a) => {
    const o = a as Record<string, unknown>
    return { date: str(o.date, 10), ruleId: str(o.ruleId, 40), memberId: str(o.memberId, 40), postCall: Boolean(o.postCall) }
  })
  return {
    status: s.status === 'final' ? 'final' : 'review',
    assignments,
    students,
    presenters,
    generatedAt: int(s.generatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    reviewUntil: int(s.reviewUntil, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    source: s.source === 'ai' || s.source === 'manual' ? s.source : 'solver',
  }
}


// ---------- storage ----------

export interface ApiOptions {
  store: Store | Promise<Store>
  /** Google OAuth client ID. When set, hosting a new session needs a Google sign-in. */
  googleClientId?: string
  /** Checks a Google ID token; defaults to Google's real keys. Tests pass a fake. */
  verifyGoogle?: GoogleVerify
  /** Signs account tokens; defaults to SESSION_SECRET. */
  secret?: string
  /** Who may create sessions: emails, or "@domain" for a whole domain. Empty = any signed-in account. */
  hostAllowlist?: string[]
}

const CODE = /^[a-z]+-[a-z]+-[a-z]+$/
const MINUTE = 60_000
const TOO_MANY = 'Too many attempts — please wait a few minutes and try again.'

export function createApi(opts: ApiOptions) {
  const storeReady = Promise.resolve(opts.store)
  const accounts = accountTokens(opts.secret ?? secretFromEnv())
  const clientId = opts.googleClientId ?? ''
  const verify = opts.verifyGoogle ?? (clientId ? googleVerifier(clientId) : null)
  const allow = (opts.hostAllowlist ?? []).map(normEmail).filter(Boolean)
  const canHost = (a: Account | null) =>
    clientId ? Boolean(a) && (!allow.length || allow.some((x) => (x.startsWith('@') ? a!.email.endsWith(x) : a!.email === x))) : true

  // The last version of each session this server has seen. Every read checks the stored version first,
  // so a save by another server copy is never missed.
  const cache = new Map<string, StoredSession>()
  const remember = (s: StoredSession) => {
    cache.delete(s.code)
    cache.set(s.code, s)
    if (cache.size > 300) cache.delete(cache.keys().next().value!)
  }

  const limits = {
    create: new Limiter(20, 60 * MINUTE),
    signIn: new Limiter(30, 10 * MINUTE),
    pinByIp: new Limiter(40, 10 * MINUTE),
    pinByName: new Limiter(8, 15 * MINUTE),
    join: new Limiter(10, 60 * MINUTE),
    unknownCode: new Limiter(100, 10 * MINUTE),
  }
  const ip = (req: Request) => req.ip ?? 'unknown'

  /** The stored session, for reading only. */
  async function read(req: Request, code: string): Promise<StoredSession> {
    if (limits.unknownCode.blocked(ip(req))) throw new HttpError(429, TOO_MANY)
    const store = await storeReady
    const cached = CODE.test(code) ? cache.get(code) : undefined
    if (cached && (await store.version(code)) === cached.version) return cached
    const r = CODE.test(code) ? await store.get(code) : null
    if (!r) {
      limits.unknownCode.hit(ip(req))
      throw new HttpError(404, 'Session not found')
    }
    const raw = r.data as StoredSession
    const s = { ...raw, ...normalizeSession(raw), version: r.version, pendingAuth: raw.pendingAuth ?? {}, hosts: raw.hosts ?? [] } as StoredSession
    remember(s)
    return s
  }

  async function write(s: StoredSession): Promise<boolean> {
    const next = { ...s, version: s.version + 1 }
    const ok = await (await storeReady).put(next.code, next.version, next, next.hosts.map((h) => h.email))
    if (ok) {
      remember(next)
      s.version = next.version
    } else cache.delete(s.code)
    return ok
  }

  /**
   * Load a fresh copy, apply `fn`, save. If someone saved in between, start again from their version.
   * `fn` may therefore run more than once; it returns what to send back (or nothing for the session view).
   */
  async function mutate<T>(req: Request, code: string, fn: (s: StoredSession, me: Who) => T): Promise<T | View> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const s = structuredClone(await read(req, code))
      const out = fn(s, who(req, s))
      if (await write(s)) return out === undefined ? view(req, s) : out
    }
    throw new HttpError(503, 'Busy — please try again')
  }

  function toPublic(s: StoredSession): PublicSession {
    const { hostToken: _h, auth, pendingAuth: _p, hosts: _o, ...rest } = s
    return { ...rest, claimed: Object.keys(auth) }
  }

  const account = (req: Request): Account | null => accounts.read(req.header('x-wayneday-account'))

  function who(req: Request, s: StoredSession) {
    const t = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const tokens = t ? t.split(',') : []
    const acct = account(req)
    const byToken = tokens.some((x) => safeEqual(x, s.hostToken))
    const byGoogle = acct ? s.hosts.find((h) => h.email === acct.email) : undefined
    const hostRole: HostEntry['role'] | null = byToken || byGoogle?.role === 'owner' ? 'owner' : byGoogle ? 'cohost' : null
    const memberId = Object.entries(s.auth).find(([, a]) => a.tokens.some((x) => tokens.some((y) => safeEqual(x, y))))?.[0] ?? null
    const pendingJoinId = memberId
      ? null
      : (Object.entries(s.pendingAuth).find(([, a]) => tokens.some((y) => safeEqual(a.token, y)))?.[0] ?? null)
    return { isHost: hostRole !== null, hostRole, memberId, pendingJoinId, byToken, account: acct }
  }
  type Who = ReturnType<typeof who>
  type View = ReturnType<typeof view>

  function view(req: Request, s: StoredSession) {
    const { byToken: _b, account: _a, ...me } = who(req, s)
    // Host emails are only shown to hosts.
    return { session: toPublic(s), me, ...(me.isHost ? { hosts: s.hosts } : {}) }
  }

  const router = express.Router()
  router.use(express.json({ limit: '2mb' }))

  const handle =
    (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .then((out) => {
          if (out !== undefined) res.json(out)
        })
        .catch((e: unknown) => next(e instanceof OpError ? new HttpError(e.status, e.message) : e))
    }
  const code = (req: Request) => String(req.params.code)

  // ---------- server info and accounts ----------

  router.get(
    '/health',
    handle(async () => {
      const store = await storeReady
      await store.ping()
      return { ok: true, store: store.kind }
    }),
  )

  router.get(
    '/config',
    handle(() => ({ googleClientId: clientId })),
  )

  router.post(
    '/auth/google',
    handle(async (req) => {
      if (!verify) throw new HttpError(400, 'Google sign-in is not set up on this server')
      if (!limits.signIn.hit(ip(req))) throw new HttpError(429, TOO_MANY)
      let acct: Account
      try {
        acct = await verify(str((req.body as { credential?: string })?.credential, 4000))
      } catch {
        throw new HttpError(401, 'Google sign-in failed — please try again')
      }
      return { token: accounts.issue(acct), account: acct }
    }),
  )

  router.get(
    '/me',
    handle(async (req) => {
      const acct = account(req)
      if (!acct) throw new HttpError(401, 'Sign in with Google first')
      const codes = await (await storeReady).listByHost(acct.email)
      const sessions = []
      for (const c of codes) {
        const s = await read(req, c).catch(() => null)
        if (!s) continue
        sessions.push({
          code: s.code,
          title: s.config.title,
          startDate: s.config.startDate,
          endDate: s.config.endDate,
          role: s.hosts.find((h) => h.email === acct.email)?.role ?? 'cohost',
          status: !s.schedule ? 'collecting' : s.schedule.status,
        })
      }
      return { account: acct, canHost: canHost(acct), sessions }
    }),
  )

  // ---------- sessions ----------

  router.post(
    '/sessions',
    handle(async (req) => {
      const acct = account(req)
      if (clientId && !acct) throw new HttpError(401, 'Sign in with Google to host a session')
      if (!canHost(acct)) throw new HttpError(403, 'Hosting on this site is by invitation. Ask the person who runs it to add your email.')
      if (!limits.create.hit(ip(req))) throw new HttpError(429, TOO_MANY)
      const today = new Date().toISOString().slice(0, 10)
      for (let i = 0; i < 20; i++) {
        const s: StoredSession = {
          code: randomCode(),
          createdAt: Date.now(),
          version: 0,
          hostToken: token(),
          hosts: acct ? [{ email: acct.email, name: acct.name, role: 'owner', addedAt: Date.now() }] : [],
          auth: {},
          pendingAuth: {},
          claimed: [],
          swaps: [],
          joinRequests: [],
          changes: [],
          // New sessions share student places equally unless the host sets a number.
          config: cleanConfig({ title: (req.body as { title?: string })?.title, startDate: today, endDate: today, students: { auto: true } }),
          responses: {},
          schedule: null,
          concerns: [],
        }
        // Saving version 1 only succeeds if the code is unused.
        if (await write(s)) return { code: s.code, hostToken: s.hostToken }
      }
      throw new HttpError(503, 'Could not pick a free code — please try again')
    }),
  )

  router.get(
    '/sessions/:code',
    handle(async (req) => {
      const since = Number(req.query.since)
      if (Number.isInteger(since) && since >= 0 && CODE.test(code(req)) && (await (await storeReady).version(code(req))) === since) {
        return { unchanged: true }
      }
      const s = await read(req, code(req))
      const me = who(req, s)
      const acct = me.account
      // A session made before Google sign-in: the host's device signs in, and that account becomes the owner.
      if (acct && me.byToken && !s.hosts.some((h) => h.role === 'owner')) {
        return mutate(req, code(req), (x) => {
          if (!x.hosts.some((h) => h.role === 'owner')) x.hosts.unshift({ email: acct.email, name: acct.name, role: 'owner', addedAt: Date.now() })
        })
      }
      // A co-host added by email shows their Google name once they've signed in.
      if (acct && s.hosts.some((h) => h.email === acct.email && h.name === h.email && acct.name !== acct.email)) {
        return mutate(req, code(req), (x) => {
          for (const h of x.hosts) if (h.email === acct.email && h.name === h.email) h.name = acct.name
        })
      }
      return view(req, s)
    }),
  )

  router.post(
    '/sessions/:code/hosts',
    handle((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const email = normEmail(str(b.email, 200))
      const action = str(b.action, 10)
      return mutate(req, code(req), (s, me) => {
        if (action === 'add') {
          if (me.hostRole !== 'owner') throw new HttpError(403, 'Only the owner can add co-hosts')
          if (!isEmail(email)) throw new HttpError(400, 'That doesn’t look like an email address')
          if (s.hosts.some((h) => h.email === email)) throw new HttpError(409, 'Already a host')
          if (s.hosts.length >= 10) throw new HttpError(400, 'A session can have up to 10 hosts')
          s.hosts.push({ email, name: str(b.name, 60).trim() || email, role: 'cohost', addedAt: Date.now() })
        } else if (action === 'remove') {
          const h = s.hosts.find((x) => x.email === email)
          if (!h) throw new HttpError(404, 'Not a host')
          if (h.role === 'owner') throw new HttpError(400, 'The owner can’t be removed')
          if (me.hostRole !== 'owner' && me.account?.email !== email) throw new HttpError(403, 'Only the owner can remove co-hosts')
          s.hosts = s.hosts.filter((x) => x !== h)
        } else throw new HttpError(400, 'Unknown action')
      })
    }),
  )

  router.put(
    '/sessions/:code/config',
    handle((req) => {
      const config = cleanConfig(req.body)
      return mutate(req, code(req), (s, me) => {
        if (!me.isHost) throw new HttpError(403, 'Only the host can edit the setup')
        s.config = config
        const ids = new Set(s.config.members.map((m) => m.id))
        for (const k of Object.keys(s.responses)) if (!ids.has(k)) delete s.responses[k]
        for (const k of Object.keys(s.auth)) if (!ids.has(k)) delete s.auth[k]
      })
    }),
  )

  router.post(
    '/sessions/:code/claim',
    handle(async (req) => {
      const body = (req.body ?? {}) as { memberId?: string; pin?: string }
      const memberId = str(body.memberId, 40)
      const pin = str(body.pin, 20)
      if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'PIN must be 4–8 digits')
      const nameKey = `${code(req)}:${memberId}`
      if (!limits.pinByIp.hit(ip(req)) || !limits.pinByName.hit(nameKey)) throw new HttpError(429, TOO_MANY)
      const out = await mutate(req, code(req), (s) => {
        if (!s.config.members.some((m) => m.id === memberId)) throw new HttpError(404, 'No such member')
        const existing = s.auth[memberId]
        if (existing) {
          if (!safeEqual(hashPin(pin, existing.salt), existing.hash)) throw new HttpError(401, 'Wrong PIN for this name')
        } else {
          const salt = randomBytes(8).toString('hex')
          s.auth[memberId] = { salt, hash: hashPin(pin, salt), tokens: [] }
        }
        const t = token()
        s.auth[memberId].tokens = [...s.auth[memberId].tokens.slice(-9), t]
        return { memberToken: t }
      })
      limits.pinByName.reset(nameKey)
      return out
    }),
  )

  router.delete(
    '/sessions/:code/claim/:memberId',
    handle((req) =>
      mutate(req, code(req), (s, me) => {
        if (!me.isHost) throw new HttpError(403, 'Only the host can reset a login')
        delete s.auth[String(req.params.memberId)]
      }),
    ),
  )

  router.put(
    '/sessions/:code/responses/:memberId',
    handle((req) => {
      const response = cleanResponse(req.body)
      return mutate(req, code(req), (s, me) => {
        saveResponse(s, me, String(req.params.memberId), response)
      })
    }),
  )

  router.put(
    '/sessions/:code/schedule',
    handle((req) => {
      const schedule = cleanSchedule(req.body)
      return mutate(req, code(req), (s, me) => {
        if (!me.isHost) throw new HttpError(403, 'Only the host can publish a roster')
        s.schedule = schedule
      })
    }),
  )

  router.post(
    '/sessions/:code/concerns',
    handle((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const text = str(b.text, 1000).trim()
      if (!text) throw new HttpError(400, 'Write something first')
      const concernId = id()
      return mutate(req, code(req), (s, me) => {
        if (!me.memberId && !me.isHost) throw new HttpError(401, 'Log in to post a concern')
        if (!me.isHost && (!s.schedule || s.schedule.status !== 'review' || Date.now() > s.schedule.reviewUntil)) {
          throw new HttpError(409, 'The concern period is closed')
        }
        const concern: Concern = {
          id: concernId,
          memberId: me.memberId ?? 'host',
          text,
          ...(isDate(b.date) ? { date: b.date } : {}),
          ...(typeof b.shiftId === 'string' && b.shiftId ? { shiftId: str(b.shiftId, 40) } : {}),
          createdAt: Date.now(),
          resolved: false,
        }
        s.concerns = [...s.concerns.slice(-499), concern]
      })
    }),
  )

  router.patch(
    '/sessions/:code/concerns/:id',
    handle((req) =>
      mutate(req, code(req), (s, me) => {
        if (!me.isHost) throw new HttpError(403, 'Only the host can resolve concerns')
        const c = s.concerns.find((x) => x.id === req.params.id)
        if (!c) throw new HttpError(404, 'No such concern')
        c.resolved = Boolean((req.body as { resolved?: boolean })?.resolved)
      }),
    ),
  )

  const shiftRef = (v: unknown) => {
    const o = (v ?? {}) as Record<string, unknown>
    return { date: str(o.date, 10), shiftId: str(o.shiftId, 40), requirementId: str(o.requirementId, 40) }
  }

  router.post(
    '/sessions/:code/swaps',
    handle((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      return mutate(req, code(req), (s, me) => {
        requestSwap(s, me, { ...shiftRef(b), note: str(b.note, 500) })
      })
    }),
  )

  router.post(
    '/sessions/:code/swaps/:id',
    handle((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const action = str(b.action, 20)
      const a: SwapAction =
        action === 'offer'
          ? { action, ...(b.give ? { give: shiftRef(b.give) } : {}) }
          : action === 'accept'
            ? { action, offerId: str(b.offerId, 40) }
            : action === 'withdraw' || action === 'approve' || action === 'decline' || action === 'cancel'
              ? { action }
              : (() => {
                  throw new HttpError(400, 'Unknown action')
                })()
      return mutate(req, code(req), (s, me) => {
        actOnSwap(s, me, String(req.params.id), a)
      })
    }),
  )

  router.post(
    '/sessions/:code/join',
    handle((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const pin = str(b.pin, 20)
      if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'PIN must be 4–8 digits')
      if (!limits.join.hit(ip(req))) throw new HttpError(429, TOO_MANY)
      const salt = randomBytes(8).toString('hex')
      const t = token()
      return mutate(req, code(req), (s) => {
        const jr = createJoin(s, str(b.name, 60), memberType(b.type))
        s.pendingAuth[jr.id] = { salt, hash: hashPin(pin, salt), token: t }
        return { requestToken: t }
      })
    }),
  )

  router.post(
    '/sessions/:code/join/:id',
    handle((req) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const jid = String(req.params.id)
      return mutate(req, code(req), (s, me) => {
        const memberId = decideJoin(s, me, jid, Boolean(b.approve), b.memberId ? str(b.memberId, 40) : undefined)
        const pending = s.pendingAuth[jid]
        if (memberId && pending) {
          // Their requested PIN becomes the login for that name, and their waiting device is logged in.
          s.auth[memberId] = { salt: pending.salt, hash: pending.hash, tokens: [pending.token] }
        }
        delete s.pendingAuth[jid]
      })
    }),
  )

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) console.error(err)
    res.status(status).json({ error: err instanceof Error && status !== 500 ? err.message : 'Server error' })
  })

  return router
}
