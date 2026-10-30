// Browser-only stand-in for the server API, used by the phone demo build (vite --mode demo).
// Everything lives on this device; a switcher picks whether you act as the host or a member.

import type { SessionView } from '../apiTypes.ts'
import { addDays } from '../shared/dates.ts'
import type { Concern, MemberResponse, PublicSession, Schedule, SessionConfig } from '../shared/types.ts'

export type { Me, SessionView } from '../apiTypes.ts'

interface Store {
  sessions: Record<string, PublicSession>
  /** code -> 'host' or a member id */
  acting: Record<string, string>
}

const KEY = 'wayneday-demo-v1'
export const SAMPLE_CODE = 'sample-night-ward'

let store: Store = load()

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as Store
  } catch {
    // storage blocked: keep it in memory
  }
  return { sessions: { [SAMPLE_CODE]: sample() }, acting: {} }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // in-memory only
  }
}

export function resetDemo() {
  store = { sessions: { [SAMPLE_CODE]: sample() }, acting: {} }
  persist()
}

export const getActing = (code: string) => store.acting[code] ?? 'host'
export function setActing(code: string, who: string) {
  store.acting[code] = who
  const s = store.sessions[code]
  if (s && who !== 'host' && !s.claimed.includes(who)) s.claimed = [...s.claimed, who]
  persist()
}
export const sessionOf = (code: string): PublicSession | undefined => store.sessions[code]

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const wait = () => new Promise((r) => setTimeout(r, 60))

function view(code: string): SessionView {
  const s = store.sessions[code]
  if (!s) throw new Error('Session not found on this device. Demo sessions only exist in this browser.')
  const who = getActing(code)
  return { session: clone(s), me: who === 'host' ? { isHost: true, memberId: null } : { isHost: false, memberId: who } }
}

async function mutate(code: string, hostOnly: boolean, fn: (s: PublicSession) => void): Promise<SessionView> {
  await wait()
  const s = store.sessions[code]
  if (!s) throw new Error('Session not found')
  if (hostOnly && getActing(code) !== 'host') throw new Error('Only the host can do that')
  fn(s)
  s.version++
  persist()
  return view(code)
}

const WORDS = 'amber cedar coral delta ember fern glacier harbor iris jade lotus maple meadow nova olive orchid pearl quartz river sage willow'.split(' ')
const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)]

// Same signatures as ../api.ts
export const getTokens = (_code: string) => ({})
export const setTokens = (_code: string, _t: unknown) => {}
export const forgetMember = (code: string) => setActing(code, 'host')

export const api = {
  async create(title: string) {
    await wait()
    let code = `${pick()}-${pick()}-${pick()}`
    while (store.sessions[code]) code = `${pick()}-${pick()}-${pick()}`
    const today = new Date().toISOString().slice(0, 10)
    store.sessions[code] = {
      code,
      createdAt: Date.now(),
      version: 0,
      config: { title, startDate: today, endDate: today, holidays: [], jobs: [], shifts: [], members: [], extraConditions: '' },
      claimed: [],
      responses: {},
      schedule: null,
      concerns: [],
    }
    store.acting[code] = 'host'
    persist()
    return { code, hostToken: 'demo' }
  },
  async get(code: string) {
    await wait()
    return view(code)
  },
  saveConfig: (code: string, config: SessionConfig) =>
    mutate(code, true, (s) => {
      s.config = clone(config)
      const ids = new Set(config.members.map((m) => m.id))
      for (const k of Object.keys(s.responses)) if (!ids.has(k)) delete s.responses[k]
      s.claimed = s.claimed.filter((id) => ids.has(id))
    }),
  async claim(code: string, memberId: string, _pin: string) {
    setActing(code, memberId)
    return { memberToken: 'demo' }
  },
  resetClaim: (code: string, memberId: string) =>
    mutate(code, true, (s) => {
      s.claimed = s.claimed.filter((id) => id !== memberId)
    }),
  saveResponse: (code: string, memberId: string, r: MemberResponse) =>
    mutate(code, false, (s) => {
      const who = getActing(code)
      if (who !== 'host' && who !== memberId) throw new Error('You can only edit your own answers')
      if (s.schedule?.status === 'final' && who !== 'host') throw new Error('The roster is final')
      s.responses[memberId] = { ...clone(r), updatedAt: Date.now() }
    }),
  saveSchedule: (code: string, schedule: Schedule | null) =>
    mutate(code, true, (s) => {
      s.schedule = clone(schedule)
    }),
  addConcern: (code: string, text: string, date?: string, shiftId?: string) =>
    mutate(code, false, (s) => {
      const who = getActing(code)
      if (who !== 'host' && (!s.schedule || s.schedule.status !== 'review' || Date.now() > s.schedule.reviewUntil)) {
        throw new Error('The concern period is closed')
      }
      if (!text.trim()) throw new Error('Write something first')
      const c: Concern = {
        id: Math.random().toString(36).slice(2, 10),
        memberId: who,
        text: text.trim(),
        ...(date ? { date } : {}),
        ...(shiftId ? { shiftId } : {}),
        createdAt: Date.now(),
        resolved: false,
      }
      s.concerns.push(c)
    }),
  resolveConcern: (code: string, id: string, resolved: boolean) =>
    mutate(code, true, (s) => {
      const c = s.concerns.find((x) => x.id === id)
      if (c) c.resolved = resolved
    }),
}

/** A realistic starting point: next month's night roster for a medicine ward, half the team has answered. */
function sample(): PublicSession {
  const now = new Date()
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const start = first.toISOString().slice(0, 10)
  const end = addDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).toISOString().slice(0, 10), -1)
  const d = (n: number) => addDays(start, n - 1)
  const month = first.toLocaleString('en', { month: 'long', timeZone: 'UTC' })
  const all = [0, 1, 2, 3, 4, 5, 6]

  const residents = ['Ann', 'Bank', 'Ploy', 'Mint', 'Tonkla', 'Fah', 'Ice', 'Nat']
  const staff = ['Dr. Somchai', 'Dr. Wipa', 'Dr. Kanok', 'Dr. Pim']
  const members = [
    ...residents.map((name) => ({ id: `r-${name.toLowerCase()}`, name, type: 'resident' as const, jobs: [] })),
    ...staff.map((name, i) => ({ id: `s-${i}`, name, type: 'staff' as const, jobs: [] })),
  ]
  const r = (o: Partial<MemberResponse>): MemberResponse => ({
    preference: 'distributed',
    minInterval: 2,
    unavailable: [],
    locks: [],
    note: '',
    updatedAt: Date.now() - 3_600_000,
    ...o,
  })

  return {
    code: SAMPLE_CODE,
    createdAt: Date.now(),
    version: 1,
    config: {
      title: `Medicine ward — ${month} nights`,
      startDate: start,
      endDate: end,
      holidays: first.getUTCMonth() === 11 ? [d(5), d(10), d(31)] : [],
      jobs: [
        { id: 'ward', name: 'Ward' },
        { id: 'er', name: 'ER' },
      ],
      shifts: [
        {
          id: 'night',
          name: 'Night',
          start: '16:00',
          end: '08:00',
          days: all,
          requirements: [
            { id: 'night-ward', jobId: 'ward', memberType: 'resident', count: 1 },
            { id: 'night-er', jobId: 'er', memberType: 'resident', count: 1 },
          ],
        },
        {
          id: 'oncall',
          name: 'Staff on-call',
          start: '08:00',
          end: '08:00',
          days: all,
          requirements: [{ id: 'oncall-any', jobId: 'ward', memberType: 'staff', count: 1 }],
        },
      ],
      members,
      extraConditions:
        'Morning round Mon–Fri 07:30: the resident coming off the Ward night presents the new admissions, so they should not be on ER the following night.\nAnn and Bank are first-years and should not be on the same night.',
    },
    claimed: ['r-ann', 'r-bank', 'r-ploy', 'r-mint', 's-1'],
    responses: {
      'r-ann': r({ preference: 'dense', minInterval: 2, unavailable: [d(3), d(4), d(5)], locks: [{ date: d(12), shiftId: 'night' }], note: 'Prefer to finish my nights early in the month' }),
      'r-bank': r({ minInterval: 3, unavailable: [d(15)], note: 'Board exam on the 15th' }),
      'r-ploy': r({ unavailable: [d(6), d(7), d(13), d(14)], note: 'Family weekend trips' }),
      'r-mint': r({ preference: 'dense', minInterval: 3, locks: [{ date: d(20), shiftId: 'night' }] }),
      's-1': r({ unavailable: [d(8), d(9), d(10), d(11), d(12)], note: 'Conference' }),
    },
    schedule: null,
    concerns: [],
  }
}
