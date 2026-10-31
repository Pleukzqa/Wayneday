// Browser-only stand-in for the server API, used by the phone demo build (vite --mode demo).
// Everything lives on this device; a switcher picks whether you act as the host or a member.

import type { SessionView } from '../apiTypes.ts'
import { addDays } from '../shared/dates.ts'
import { actOnSwap, addNote, createJoin, decideJoin, readNote, removeNote, requestSwap, saveFeedback, saveResponse, visibleFeedback, visibleNotes, type Actor, type SwapAction } from '../shared/ops.ts'
import {
  DEFAULT_STUDENTS,
  normalizeSession,
  type Concern,
  type MemberResponse,
  type MemberType,
  type PublicSession,
  type Schedule,
  type SessionConfig,
} from '../shared/types.ts'

export type { Me, SessionView } from '../apiTypes.ts'

interface Store {
  sessions: Record<string, PublicSession>
  /** code -> 'host' or a member id */
  acting: Record<string, string>
}

const KEY = 'wayneday-demo-v5'
export const SAMPLE_CODE = 'sample-night-ward'

let store: Store = load()

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const st = JSON.parse(raw) as Store
      for (const k of Object.keys(st.sessions)) st.sessions[k] = normalizeSession(st.sessions[k])
      return st
    }
  } catch {
    // storage blocked: keep it in memory
  }
  return { sessions: { [SAMPLE_CODE]: sample() }, acting: {} }
}

const listeners = new Set<() => void>()
/** Lets the demo bar re-render when people are added or renamed. */
export function onDemoChange(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function persist() {
  for (const fn of listeners) fn()
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

const actorFor = (code: string): Actor => {
  const who = getActing(code)
  return who === 'host' ? { isHost: true, memberId: null } : { isHost: false, memberId: who }
}

function view(code: string): SessionView {
  const s = store.sessions[code]
  if (!s) throw new Error('Session not found on this device. Demo sessions only exist in this browser.')
  return {
    session: { ...clone(s), notes: visibleNotes(s, actorFor(code)), feedback: visibleFeedback(s, actorFor(code)) },
    me: actorFor(code),
    organizers: code === SAMPLE_CODE ? [{ name: 'Dr. Wipa', role: 'owner' }, { name: 'Ploy', role: 'cohost' }] : [],
  }
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
  // No Google in the demo: hosting needs no sign-in there.
  config: async () => ({ googleClientId: '' }),
  signInGoogle: async (_credential: string): Promise<never> => {
    throw new Error('Not available in the demo')
  },
  mySessions: async (): Promise<never> => {
    throw new Error('Not available in the demo')
  },
  setHost: async (_code: string, _action: 'add' | 'remove', _email: string): Promise<never> => {
    throw new Error('Not available in the demo')
  },
  async create(title: string) {
    await wait()
    let code = `${pick()}-${pick()}-${pick()}`
    while (store.sessions[code]) code = `${pick()}-${pick()}-${pick()}`
    const today = new Date().toISOString().slice(0, 10)
    store.sessions[code] = {
      code,
      createdAt: Date.now(),
      version: 0,
      config: {
        title,
        rosterMode: 'hospital',
        duty: [],
        presentationOverrides: [],
        startDate: today,
        endDate: today,
        holidays: [],
        jobs: [],
        shifts: [],
        overrides: [],
        members: [],
        students: DEFAULT_STUDENTS,
        presentations: [],
        extraConditions: '',
      },
      claimed: [],
      responses: {},
      schedule: null,
      concerns: [],
      notes: [],
      feedback: [],
      swaps: [],
      joinRequests: [],
      changes: [],
    }
    store.acting[code] = 'host'
    persist()
    return { code, hostToken: 'demo' }
  },
  async get(code: string, _since = -1) {
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
  saveResponse: (code: string, memberId: string, r: MemberResponse, hostReason?: string) =>
    mutate(code, false, (s) =>
      saveResponse(s, actorFor(code), memberId, clone(r), hostReason && actorFor(code).isHost ? { reason: hostReason, by: 'Dr. Wipa', role: 'owner' } : undefined),
    ),
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
  saveFeedback: (code: string, f: { ratings: Record<string, number>; text: string; anonymous: boolean }) =>
    mutate(code, false, (s) => saveFeedback(s, actorFor(code), f)),
  addNote: (code: string, memberId: string, text: string) =>
    mutate(code, false, (s) => addNote(s, actorFor(code), memberId, text, { by: 'Dr. Wipa', role: 'owner' })),
  removeNote: (code: string, id: string) => mutate(code, false, (s) => removeNote(s, actorFor(code), id)),
  readNote: (code: string, id: string) => mutate(code, false, (s) => readNote(s, actorFor(code), id)),
  resolveConcern: (code: string, id: string, resolved: boolean) =>
    mutate(code, true, (s) => {
      const c = s.concerns.find((x) => x.id === id)
      if (c) c.resolved = resolved
    }),
  requestSwap: (code: string, body: { date: string; shiftId: string; requirementId: string; note: string }) =>
    mutate(code, false, (s) => void requestSwap(s, actorFor(code), body)),
  actOnSwap: (code: string, id: string, action: SwapAction) => mutate(code, false, (s) => actOnSwap(s, actorFor(code), id, action)),
  async requestJoin(code: string, name: string, type: MemberType, _pin: string) {
    await mutate(code, false, (s) => void createJoin(s, name, type))
    return { requestToken: 'demo' }
  },
  decideJoin: (code: string, id: string, approve: boolean, memberId?: string) =>
    mutate(code, true, (s) => void decideJoin(s, actorFor(code), id, approve, memberId)),
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
  const studentNames = ['Beam', 'Praew', 'Kaew', 'Jane']
  const rid = (n: string) => `r-${n.toLowerCase()}`
  const members = [
    ...residents.map((name) => ({ id: rid(name), name, type: 'resident' as const, jobs: [] })),
    ...staff.map((name, i) => ({ id: `s-${i}`, name, type: 'staff' as const, jobs: [] })),
    ...studentNames.map((name) => ({ id: `st-${name.toLowerCase()}`, name, type: 'student' as const, jobs: [] })),
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
  // The hospital's roster, as if pasted in: a simple rotation (Ward, ER, staff on duty each night).
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1
  const duty = Array.from({ length: days }, (_, i) => [
    { date: d(i + 1), shiftId: 'night', requirementId: 'resident', memberId: rid(residents[i % 8]) },
    { date: d(i + 1), shiftId: 'night', requirementId: 'resident', memberId: rid(residents[(i + 3) % 8]) },
    { date: d(i + 1), shiftId: 'night', requirementId: 'staff', memberId: `s-${i % 4}` },
  ]).flat()
  // Week 3 is exam week: one presentation a day instead of two.
  const third = Array.from({ length: 7 }, (_, i) => d(15 + i)).filter((x) => [1, 2, 3, 4, 5].includes(new Date(x + 'T00:00:00Z').getUTCDay()))

  return {
    code: SAMPLE_CODE,
    createdAt: Date.now(),
    version: 1,
    config: {
      title: `Medicine ward — ${month} nights`,
      rosterMode: 'hospital',
      duty,
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
          // Student places: one on the ward and one in the ER each night.
          requirements: [
            { id: 'night-ward', jobId: 'ward', memberType: 'any', count: 1 },
            { id: 'night-er', jobId: 'er', memberType: 'any', count: 1 },
          ],
        },
      ],
      overrides: [],
      members,
      students: { shiftIds: ['night'], maxPerShift: 1, shiftsPerStudent: 6, avoidRepeatPartner: true, minGap: 2 },
      presentations: [
        {
          id: 'morning-report',
          name: 'Morning report',
          days: [1, 2, 3, 4, 5],
          count: 2,
          fromShiftId: 'night',
          fromCount: 1,
          types: ['resident', 'student'],
        },
      ],
      presentationOverrides: third.map((date) => ({ date, ruleId: 'morning-report', active: true, count: 1 })),
      extraConditions: 'Beam and Praew are from the same group and shouldn’t be on nights back to back.',
    },
    claimed: ['st-beam', 'st-praew', 'st-kaew'],
    responses: {
      'st-beam': r({ unavailable: [d(3), d(4), d(5)], avoid: [{ date: d(10), level: 3 }, { date: d(11), level: 2 }], note: 'Surgery rotation exam on the 4th' }),
      'st-jane': r({ avoid: [{ date: d(20), level: 1 }, { date: d(21), level: 1 }] }),
      'st-praew': r({ preference: 'dense', minInterval: 2, note: 'Prefer to finish nights early' }),
      'st-kaew': r({ minInterval: 3, unavailable: [d(13), d(14)], locks: [{ date: d(20), shiftId: 'night' }] }),
    },
    schedule: null,
    concerns: [],
    notes: [],
    feedback: [],
    swaps: [],
    joinRequests: [{ id: 'join-pond', name: 'Pond', type: 'student', status: 'pending', createdAt: Date.now() - 600_000 }],
    changes: [],
  }
}
