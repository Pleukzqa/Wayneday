// Shift solver.
//
// 1. Expand the config into "seats" (one per person needed per shift per day).
// 2. Run cheap capacity checks that explain *why* a roster is impossible.
// 3. Find any arrangement that satisfies every hard rule (backtracking search, most-constrained seat first).
// 4. Improve it with simulated annealing on soft goals: fair totals, fair weekends/holidays,
//    fair shift types, and each member's distributed/dense preference (distributed weighted higher).

import { dateRange, dayDiff, weekday } from './dates.ts'
import {
  DEFAULT_RESPONSE,
  type Assignment,
  type Member,
  type MemberResponse,
  type MemberType,
  type SessionConfig,
} from './types.ts'

export interface Seat {
  index: number
  day: number
  date: string
  shiftId: string
  requirementId: string
  jobId: string
  type: MemberType | 'any'
  weekend: boolean
}

export interface MemberStats {
  memberId: string
  total: number
  weekend: number
  byShift: Record<string, number>
  minGap: number | null
  avgGap: number | null
}

export type SolveResult =
  | { ok: true; assignments: Assignment[]; stats: MemberStats[]; warnings: string[]; score: number }
  | { ok: false; problems: string[]; exhausted: boolean }

export interface SolveOptions {
  seed?: number
  /** Backtracking node budget before giving up. */
  nodeLimit?: number
  /** Simulated-annealing iterations. */
  iterations?: number
}

export interface Problem {
  config: SessionConfig
  days: string[]
  seats: Seat[]
  members: Member[]
  resp: MemberResponse[]
  /** Base eligibility per seat: member indexes that fit type, job and availability. */
  eligible: number[][]
  /** member index -> set of unavailable day indexes */
  unavailable: Set<number>[]
  maxShifts: number[]
}

const label = (p: Problem, s: Seat) => {
  const shift = p.config.shifts.find((x) => x.id === s.shiftId)?.name ?? s.shiftId
  const job = p.config.jobs.find((x) => x.id === s.jobId)?.name ?? s.jobId
  return `${s.date} ${shift} · ${job} (${s.type === 'any' ? 'anyone' : s.type})`
}

export function responseFor(responses: Record<string, MemberResponse>, memberId: string): MemberResponse {
  const r = responses[memberId]
  return r ? { ...DEFAULT_RESPONSE, ...r, minInterval: Math.max(1, Math.floor(r.minInterval || 1)) } : DEFAULT_RESPONSE
}

export function buildProblem(config: SessionConfig, responses: Record<string, MemberResponse>): Problem {
  const days = dateRange(config.startDate, config.endDate)
  const dayIndex = new Map(days.map((d, i) => [d, i]))
  const holidays = new Set(config.holidays)
  const seats: Seat[] = []
  days.forEach((date, day) => {
    const wd = weekday(date)
    const weekend = wd === 0 || wd === 6 || holidays.has(date)
    for (const shift of config.shifts) {
      if (!shift.days.includes(wd)) continue
      for (const req of shift.requirements) {
        for (let k = 0; k < req.count; k++) {
          seats.push({
            index: seats.length,
            day,
            date,
            shiftId: shift.id,
            requirementId: req.id,
            jobId: req.jobId,
            type: req.memberType,
            weekend,
          })
        }
      }
    }
  })
  const members = config.members
  const resp = members.map((m) => responseFor(responses, m.id))
  const unavailable = resp.map(
    (r) => new Set(r.unavailable.map((d) => dayIndex.get(d)).filter((x): x is number => x !== undefined)),
  )
  const eligible = seats.map((s) =>
    members.flatMap((m, mi) =>
      (s.type === 'any' || s.type === m.type) &&
      (m.jobs.length === 0 || m.jobs.includes(s.jobId)) &&
      !unavailable[mi].has(s.day)
        ? [mi]
        : [],
    ),
  )
  const maxShifts = members.map((m) => (m.maxShifts != null && m.maxShifts >= 0 ? m.maxShifts : Infinity))
  return { config, days, seats, members, resp, eligible, unavailable, maxShifts }
}

/** Largest number of days a member could work inside [from, to] given spacing and availability (greedy is optimal). */
function capacityIn(p: Problem, mi: number, workable: Set<number>, from: number, to: number) {
  const gap = p.resp[mi].minInterval
  let n = 0
  let last = -Infinity
  for (let d = from; d <= to; d++) {
    if (workable.has(d) && d - last >= gap) {
      n++
      last = d
    }
  }
  return Math.min(n, p.maxShifts[mi])
}

/** Necessary-condition checks with human-readable explanations. Empty = no obvious blocker. */
export function diagnose(p: Problem): string[] {
  const problems: string[] = []
  if (p.days.length === 0) problems.push('Set a valid date range.')
  if (p.config.shifts.length === 0) problems.push('Add at least one shift.')
  if (p.members.length === 0) problems.push('Add at least one member.')
  if (p.seats.length === 0 && problems.length === 0) problems.push('No shift positions fall inside the date range.')
  if (problems.length) return problems

  // Seats nobody can take.
  for (const s of p.seats) {
    if (p.eligible[s.index].length === 0) problems.push(`${label(p, s)}: nobody qualified is available.`)
  }

  // A person works at most one shift per day.
  for (let day = 0; day < p.days.length; day++) {
    const seats = p.seats.filter((s) => s.day === day)
    const people = new Set(seats.flatMap((s) => p.eligible[s.index]))
    if (seats.length > people.size) {
      problems.push(`${p.days[day]}: ${seats.length} positions but only ${people.size} people can work that day.`)
    }
  }

  // Locks.
  problems.push(...lockProblems(p))

  // Window capacity: in every window, seats of a kind must not exceed what eligible people can cover with their spacing.
  const workable = p.members.map((_, mi) => new Set(p.seats.filter((s) => p.eligible[s.index].includes(mi)).map((s) => s.day)))
  const kinds: { name: string; match: (s: Seat) => boolean; pool: (mi: number) => boolean }[] = [
    { name: 'positions', match: () => true, pool: () => true },
    { name: 'resident positions', match: (s) => s.type === 'resident', pool: (mi) => p.members[mi].type === 'resident' },
    { name: 'staff positions', match: (s) => s.type === 'staff', pool: (mi) => p.members[mi].type === 'staff' },
  ]
  const n = p.days.length
  const windows = [...new Set([n, ...Array.from({ length: Math.min(n, 14) }, (_, i) => i + 1)])]
  const reported = new Set<string>()
  for (const kind of kinds) {
    for (const w of windows) {
      for (let from = 0; from + w <= n; from++) {
        const to = from + w - 1
        const need = p.seats.filter((s) => s.day >= from && s.day <= to && kind.match(s)).length
        if (need === 0) continue
        let cap = 0
        p.members.forEach((_, mi) => {
          if (kind.pool(mi)) cap += capacityIn(p, mi, workable[mi], from, to)
        })
        if (need > cap && !reported.has(kind.name)) {
          reported.add(kind.name)
          const range = from === to ? p.days[from] : `${p.days[from]} → ${p.days[to]}`
          problems.push(
            `${range}: ${need} ${kind.name} to fill, but given minimum intervals, availability and caps people can cover at most ${cap}.`,
          )
        }
      }
    }
  }
  return problems
}

function lockProblems(p: Problem): string[] {
  const out: string[] = []
  p.members.forEach((m, mi) => {
    const locks = [...p.resp[mi].locks].sort((a, b) => a.date.localeCompare(b.date))
    for (const l of locks) {
      const shift = p.config.shifts.find((s) => s.id === l.shiftId)
      if (!shift) out.push(`${m.name}: locked to a shift that no longer exists.`)
      else if (!p.seats.some((s) => s.date === l.date && s.shiftId === l.shiftId))
        out.push(`${m.name}: locked to ${shift.name} on ${l.date}, but that shift doesn't run then.`)
      else if (p.resp[mi].unavailable.includes(l.date)) out.push(`${m.name}: both locked and unavailable on ${l.date}.`)
    }
    for (let i = 1; i < locks.length; i++) {
      const gap = dayDiff(locks[i - 1].date, locks[i].date)
      if (gap < p.resp[mi].minInterval)
        out.push(`${m.name}: locks on ${locks[i - 1].date} and ${locks[i].date} break their ${p.resp[mi].minInterval}-day interval.`)
    }
    if (locks.length > p.maxShifts[mi]) out.push(`${m.name}: ${locks.length} locks exceed their cap of ${p.maxShifts[mi]}.`)
  })
  return out
}

function rng(seed: number) {
  let a = seed >>> 0 || 1
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class State {
  assign: Int32Array
  days: number[][]
  fixed: Uint8Array
  /** day index -> members working that day */
  onDay: Set<number>[]
  p: Problem
  constructor(p: Problem) {
    this.p = p
    this.assign = new Int32Array(p.seats.length).fill(-1)
    this.days = p.members.map(() => [])
    this.fixed = new Uint8Array(p.seats.length)
    this.onDay = p.days.map(() => new Set())
  }
  /** Can member mi work on `day`, ignoring one existing shift on `ignoreDay`? */
  fits(mi: number, day: number, ignoreDay = -1) {
    const gap = this.p.resp[mi].minInterval
    let count = 0
    let ignored = false
    for (const d of this.days[mi]) {
      if (!ignored && d === ignoreDay) {
        ignored = true
        continue
      }
      if (Math.abs(d - day) < gap) return false
      count++
    }
    return count < this.p.maxShifts[mi]
  }
  place(seat: number, mi: number) {
    this.assign[seat] = mi
    const arr = this.days[mi]
    const day = this.p.seats[seat].day
    let i = arr.length
    while (i > 0 && arr[i - 1] > day) i--
    arr.splice(i, 0, day)
    this.onDay[day].add(mi)
  }
  remove(seat: number) {
    const mi = this.assign[seat]
    if (mi < 0) return
    const arr = this.days[mi]
    const day = this.p.seats[seat].day
    arr.splice(arr.indexOf(day), 1)
    this.onDay[day].delete(mi)
    this.assign[seat] = -1
  }
}

function applyLocks(p: Problem, st: State): string[] {
  const problems: string[] = []
  p.members.forEach((m, mi) => {
    for (const l of p.resp[mi].locks) {
      const seat = p.seats.find(
        (s) => s.date === l.date && s.shiftId === l.shiftId && st.assign[s.index] < 0 && p.eligible[s.index].includes(mi),
      )
      if (!seat) {
        const shift = p.config.shifts.find((s) => s.id === l.shiftId)?.name ?? 'shift'
        problems.push(`${m.name}: no open position they qualify for in ${shift} on ${l.date} for their lock.`)
        continue
      }
      st.place(seat.index, mi)
      st.fixed[seat.index] = 1
    }
  })
  return problems
}

function search(p: Problem, st: State, rand: () => number, nodeLimit: number): 'found' | 'exhausted' | 'limit' {
  let nodes = 0
  const counts = () => st.days.map((d) => d.length)
  const rec = (): 'found' | 'exhausted' | 'limit' => {
    if (++nodes > nodeLimit) return 'limit'
    // Most constrained open seat.
    let best = -1
    let bestCands: number[] = []
    for (const s of p.seats) {
      if (st.assign[s.index] >= 0) continue
      const taken = st.onDay[s.day]
      const cands = p.eligible[s.index].filter((mi) => !taken.has(mi) && st.fits(mi, s.day))
      if (best < 0 || cands.length < bestCands.length) {
        best = s.index
        bestCands = cands
        if (cands.length === 0) break
      }
    }
    if (best < 0) return 'found'
    if (bestCands.length === 0) return 'exhausted'
    // Prefer people with fewer shifts so far, then whoever's preference this placement suits.
    const c = counts()
    const day = p.seats[best].day
    const keyed = bestCands.map((mi) => {
      const near = st.days[mi].reduce((m, d) => Math.min(m, Math.abs(d - day)), Infinity)
      const prefKey = p.resp[mi].preference === 'distributed' ? -Math.min(near, 99) : Math.min(near, 99)
      return { mi, k: c[mi] * 1000 + prefKey + rand() }
    })
    keyed.sort((a, b) => a.k - b.k)
    for (const { mi } of keyed) {
      st.place(best, mi)
      const r = rec()
      if (r !== 'exhausted') return r
      st.remove(best)
    }
    return 'exhausted'
  }
  return rec()
}

// Distributed is scored quadratically with weight 40, dense linearly with 30: dense people get clustered
// without squeezing the people who asked for spread-out shifts (distributed takes priority).
const DENSE_WEIGHT = 30

/** Soft-goal score, lower is better. */
export function scoreState(p: Problem, days: number[][], assign: ArrayLike<number>) {
  const n = p.days.length
  const weekend = p.members.map(() => 0)
  const byShift = p.members.map(() => new Map<string, number>())
  for (const s of p.seats) {
    const mi = assign[s.index]
    if (mi < 0) continue
    if (s.weekend) weekend[mi]++
    byShift[mi].set(s.shiftId, (byShift[mi].get(s.shiftId) ?? 0) + 1)
  }
  let score = 0
  for (const type of ['resident', 'staff'] as const) {
    const idx = p.members.flatMap((m, mi) => (m.type === type ? [mi] : []))
    if (idx.length === 0) continue
    score += 100 * variance(idx.map((mi) => days[mi].length), idx.map((mi) => p.maxShifts[mi]))
    score += 30 * variance(idx.map((mi) => weekend[mi]))
    for (const sh of p.config.shifts) score += 10 * variance(idx.map((mi) => byShift[mi].get(sh.id) ?? 0))
  }
  p.members.forEach((_, mi) => {
    const d = days[mi]
    if (d.length < 2) return
    const gap = p.resp[mi].minInterval
    if (p.resp[mi].preference === 'distributed') {
      // Even spacing across the whole period; weighted above dense so spreading wins conflicts.
      const ideal = n / d.length
      const gaps = [d[0] + 1, ...d.slice(1).map((x, i) => x - d[i]), n - d[d.length - 1]]
      let c = 0
      gaps.forEach((g, i) => {
        const w = i === 0 || i === gaps.length - 1 ? 0.5 : 1
        c += w * ((ideal - g) / ideal) ** 2
      })
      score += 40 * c
    } else {
      // Clustered, as close to the member's minimum interval as possible.
      const ideal = n / d.length
      let c = 0
      for (let i = 1; i < d.length; i++) c += Math.abs(d[i] - d[i - 1] - gap) / ideal
      score += DENSE_WEIGHT * c
    }
  })
  return score
}

function variance(xs: number[], caps?: number[]) {
  if (xs.length < 2) return 0
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((a, x, i) => {
    // Someone capped below the mean isn't "unfair" for sitting at their cap.
    const target = caps && caps[i] < mean ? caps[i] : mean
    return a + (x - target) ** 2
  }, 0) / xs.length
}

function anneal(p: Problem, st: State, rand: () => number, iterations: number) {
  const free = p.seats.filter((s) => !st.fixed[s.index]).map((s) => s.index)
  if (free.length === 0) return scoreState(p, st.days, st.assign)
  const busy = (mi: number, day: number) => st.onDay[day].has(mi)
  let cur = scoreState(p, st.days, st.assign)
  let best = cur
  let bestAssign = Int32Array.from(st.assign)
  let temp = 20
  const cool = Math.pow(0.01 / temp, 1 / iterations)
  for (let it = 0; it < iterations; it++, temp *= cool) {
    const a = free[Math.floor(rand() * free.length)]
    const sa = p.seats[a]
    const ma = st.assign[a]
    if (rand() < 0.5) {
      // Move: hand seat a to someone else.
      const el = p.eligible[a]
      const mb = el[Math.floor(rand() * el.length)]
      if (mb === ma || busy(mb, sa.day) || !st.fits(mb, sa.day)) continue
      st.remove(a)
      st.place(a, mb)
      const next = scoreState(p, st.days, st.assign)
      if (next <= cur || rand() < Math.exp((cur - next) / temp)) cur = next
      else {
        st.remove(a)
        st.place(a, ma)
      }
    } else {
      // Swap the people on seats a and b.
      const b = free[Math.floor(rand() * free.length)]
      const sb = p.seats[b]
      const mb = st.assign[b]
      if (a === b || ma === mb || sa.day === sb.day) continue
      if (!p.eligible[a].includes(mb) || !p.eligible[b].includes(ma)) continue
      st.remove(a)
      st.remove(b)
      const ok = !busy(mb, sa.day) && !busy(ma, sb.day) && st.fits(mb, sa.day) && st.fits(ma, sb.day)
      if (ok) {
        st.place(a, mb)
        st.place(b, ma)
        const next = scoreState(p, st.days, st.assign)
        if (next <= cur || rand() < Math.exp((cur - next) / temp)) {
          cur = next
        } else {
          st.remove(a)
          st.remove(b)
          st.place(a, ma)
          st.place(b, mb)
        }
      } else {
        st.place(a, ma)
        st.place(b, mb)
      }
    }
    if (cur < best) {
      best = cur
      bestAssign = Int32Array.from(st.assign)
    }
  }
  // Restore the best arrangement seen.
  for (const s of p.seats) st.remove(s.index)
  bestAssign.forEach((mi, seat) => st.place(seat, mi))
  return best
}

export function statsFor(p: Problem, assign: ArrayLike<number>): MemberStats[] {
  return p.members.map((m, mi) => {
    const seats = p.seats.filter((s) => assign[s.index] === mi)
    const days = seats.map((s) => s.day).sort((a, b) => a - b)
    const gaps = days.slice(1).map((d, i) => d - days[i])
    const byShift: Record<string, number> = {}
    for (const s of seats) byShift[s.shiftId] = (byShift[s.shiftId] ?? 0) + 1
    return {
      memberId: m.id,
      total: seats.length,
      weekend: seats.filter((s) => s.weekend).length,
      byShift,
      minGap: gaps.length ? Math.min(...gaps) : null,
      avgGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    }
  })
}

export function solve(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  opts: SolveOptions = {},
): SolveResult {
  const p = buildProblem(config, responses)
  const problems = diagnose(p)
  if (problems.length) return { ok: false, problems, exhausted: true }
  const st = new State(p)
  const lockIssues = applyLocks(p, st)
  if (lockIssues.length) return { ok: false, problems: lockIssues, exhausted: true }
  const rand = rng(opts.seed ?? 1)
  const outcome = search(p, st, rand, opts.nodeLimit ?? 30_000)
  if (outcome !== 'found') {
    return {
      ok: false,
      exhausted: outcome === 'exhausted',
      problems: [
        outcome === 'exhausted'
          ? 'No possible arrangement: every combination breaks a minimum interval, an unavailable date, a lock or a cap.'
          : 'No arrangement found within the search limit. It is probably impossible — try lowering minimum intervals, freeing unavailable dates, or adding people.',
      ],
    }
  }
  const score = anneal(p, st, rand, opts.iterations ?? 150_000)
  const assignments: Assignment[] = p.seats.map((s) => ({
    date: s.date,
    shiftId: s.shiftId,
    requirementId: s.requirementId,
    memberId: p.members[st.assign[s.index]].id,
  }))
  const stats = statsFor(p, st.assign)
  const warnings: string[] = []
  for (const type of ['resident', 'staff'] as const) {
    const totals = stats.filter((s) => p.members.find((m) => m.id === s.memberId)?.type === type).map((s) => s.total)
    if (totals.length && Math.max(...totals) - Math.min(...totals) > 1) {
      warnings.push(`${type[0].toUpperCase() + type.slice(1)} totals range from ${Math.min(...totals)} to ${Math.max(...totals)} (limited by availability, caps or intervals).`)
    }
  }
  return { ok: true, assignments, stats, warnings, score }
}

/** Check any arrangement (AI output, manual edits) against the hard rules. */
export function validate(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  assignments: Assignment[],
): string[] {
  const p = buildProblem(config, responses)
  const out: string[] = []
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? id
  const memberIdx = new Map(config.members.map((m, i) => [m.id, i]))
  const used = new Set<Assignment>()
  // Match assignments to seats.
  for (const s of p.seats) {
    const a = assignments.find(
      (x) => !used.has(x) && x.date === s.date && x.shiftId === s.shiftId && x.requirementId === s.requirementId,
    )
    if (!a) {
      out.push(`${label(p, s)} is unfilled.`)
      continue
    }
    used.add(a)
    const mi = memberIdx.get(a.memberId)
    if (mi === undefined) out.push(`${label(p, s)}: unknown member.`)
    else if (!p.eligible[s.index].includes(mi)) {
      out.push(
        p.unavailable[mi].has(s.day)
          ? `${name(a.memberId)} is unavailable on ${s.date}.`
          : `${name(a.memberId)} doesn't qualify for ${label(p, s)}.`,
      )
    }
  }
  for (const a of assignments) if (!used.has(a)) out.push(`${name(a.memberId)} on ${a.date} doesn't match any open position.`)
  p.members.forEach((m, mi) => {
    const mine = assignments.filter((a) => a.memberId === m.id)
    const dates = mine.map((a) => a.date).sort()
    for (let i = 1; i < dates.length; i++) {
      const gap = dayDiff(dates[i - 1], dates[i])
      if (gap === 0) out.push(`${m.name} has two shifts on ${dates[i]}.`)
      else if (gap < p.resp[mi].minInterval) out.push(`${m.name}: ${dates[i - 1]} and ${dates[i]} are closer than ${p.resp[mi].minInterval} days.`)
    }
    if (mine.length > p.maxShifts[mi]) out.push(`${m.name} has ${mine.length} shifts, above their cap of ${p.maxShifts[mi]}.`)
    for (const l of p.resp[mi].locks) {
      if (!mine.some((a) => a.date === l.date && a.shiftId === l.shiftId)) out.push(`${m.name}'s lock on ${l.date} isn't honoured.`)
    }
  })
  return [...new Set(out)]
}
