// Shift solver.
//
// 1. Expand the config into "seats" (one per person needed per shift per day).
// 2. Run cheap capacity checks that explain *why* a roster is impossible.
// 3. Find any arrangement that satisfies every hard rule (backtracking search, most-constrained seat first).
// 4. Improve it with simulated annealing on soft goals: fair totals, fair weekends/holidays,
//    fair shift types, and each member's distributed/dense preference (distributed weighted higher).

import { reqCount } from './calendar.ts'
import { dateRange, dayDiff, weekday } from './dates.ts'
import { preferenceCost, responseFor, rng, variance } from './scoring.ts'
import { arrangeStudents, pickPresenters, validateStudents } from './students.ts'
import {
  type Assignment,
  type Member,
  type MemberResponse,
  type Roster,
  type SessionConfig,
  type WorkerType,
} from './types.ts'

export interface Seat {
  index: number
  day: number
  date: string
  shiftId: string
  requirementId: string
  jobId: string
  type: WorkerType | 'any'
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
  | ({ ok: true; stats: MemberStats[]; warnings: string[]; score: number } & Roster)
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

export { responseFor }

const label = (p: Problem, s: Seat) => {
  const shift = p.config.shifts.find((x) => x.id === s.shiftId)?.name ?? s.shiftId
  const job = p.config.jobs.find((x) => x.id === s.jobId)?.name ?? s.jobId
  return `${s.date} ${shift} · ${job} (${s.type === 'any' ? 'anyone' : s.type})`
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
      for (const req of shift.requirements) {
        const count = reqCount(config, shift, req, date)
        for (let k = 0; k < count; k++) {
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
      m.type !== 'student' &&
      (s.type === 'any' || s.type === m.type) &&
      (!s.jobId || m.jobs.length === 0 || m.jobs.includes(s.jobId)) &&
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
    if (m.type === 'student') return // checked when students are arranged
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
    if (m.type === 'student') return
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
    score += preferenceCost(days[mi], n, p.resp[mi])
  })
  return score
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
  const extra = arrangeStudents(config, responses, assignments, opts.seed ?? 1)
  if (!extra.ok) return { ok: false, problems: extra.problems, exhausted: true }
  const presenters = pickPresenters(config, responses, assignments, extra.students, opts.seed ?? 1)
  warnings.push(...extra.warnings, ...presenters.warnings)
  for (const type of ['resident', 'staff'] as const) {
    const totals = stats.filter((s) => p.members.find((m) => m.id === s.memberId)?.type === type).map((s) => s.total)
    if (totals.length && Math.max(...totals) - Math.min(...totals) > 1) {
      warnings.push(`${type[0].toUpperCase() + type.slice(1)} totals range from ${Math.min(...totals)} to ${Math.max(...totals)} (limited by availability, caps or intervals).`)
    }
  }
  return { ok: true, assignments, students: extra.students, presenters: presenters.presenters, stats, warnings, score }
}

/** Check any arrangement (AI output, manual edits, swaps) against the hard rules. */
export function validate(config: SessionConfig, responses: Record<string, MemberResponse>, roster: Roster): string[] {
  // The hospital's own roster isn't ours to judge; only students are checked.
  if (config.rosterMode === 'hospital') return validateStudents(config, responses, roster.students)
  const { assignments } = roster
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
    if (m.type === 'student') return
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
  out.push(...validateStudents(config, responses, roster.students))
  return [...new Set(out)]
}

// ---------- counting and alternatives ----------

export type CountResult = { exact: true; count: number } | { exact: false; log10: number } | { exact: true; count: 0 }

function factorial(n: number) {
  let f = 1
  for (let i = 2; i <= n; i++) f *= i
  return f
}

/**
 * How many valid resident/staff rosters exist (hard rules only; identical positions on the same shift count once).
 * Exact when the search tree is small enough to walk; otherwise a Knuth random-probe estimate of the tree size.
 */
export function countArrangements(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  opts: { nodeLimit?: number; probes?: number; seed?: number } = {},
): CountResult {
  const p = buildProblem(config, responses)
  if (diagnose(p).length) return { exact: true, count: 0 }
  const base = new State(p)
  if (applyLocks(p, base).length) return { exact: true, count: 0 }
  // Identical seats (same date + position) are interchangeable.
  const groups = new Map<string, number>()
  for (const s of p.seats) if (!base.fixed[s.index]) groups.set(`${s.day}|${s.requirementId}`, (groups.get(`${s.day}|${s.requirementId}`) ?? 0) + 1)
  let symmetry = 1
  for (const k of groups.values()) symmetry *= factorial(k)

  const open = (st: State) => {
    let best = -1
    let bestCands: number[] = []
    for (const s of p.seats) {
      if (st.assign[s.index] >= 0) continue
      const cands = p.eligible[s.index].filter((mi) => !st.onDay[s.day].has(mi) && st.fits(mi, s.day))
      if (best < 0 || cands.length < bestCands.length) {
        best = s.index
        bestCands = cands
        if (cands.length === 0) break
      }
    }
    return { best, cands: bestCands }
  }

  // Exact enumeration with a node budget.
  let nodes = 0
  const limit = opts.nodeLimit ?? 60_000
  let total = 0
  const walk = (): boolean => {
    if (++nodes > limit) return false
    const { best, cands } = open(base)
    if (best < 0) {
      total++
      return true
    }
    for (const mi of cands) {
      base.place(best, mi)
      const ok = walk()
      base.remove(best)
      if (!ok) return false
    }
    return true
  }
  if (walk()) return { exact: true, count: Math.round(total / symmetry) }

  // Knuth estimator: average of products of branching factors along random root-to-leaf paths (in log space).
  const rand = rng(opts.seed ?? 99)
  const logs: number[] = []
  const probes = opts.probes ?? 120
  for (let k = 0; k < probes; k++) {
    const st = new State(p)
    applyLocks(p, st)
    let log = 0
    for (;;) {
      const { best, cands } = open(st)
      if (best < 0) break
      if (cands.length === 0) {
        log = -Infinity
        break
      }
      log += Math.log10(cands.length)
      st.place(best, cands[Math.floor(rand() * cands.length)])
    }
    logs.push(log)
  }
  const finite = logs.filter((l) => Number.isFinite(l))
  if (finite.length === 0) return { exact: false, log10: Number.NaN }
  // log10(mean(10^l)) computed stably.
  const max = Math.max(...finite)
  const mean = finite.reduce((a, l) => a + 10 ** (l - max), 0) / logs.length
  return { exact: false, log10: max + Math.log10(mean) - Math.log10(symmetry) }
}

export interface Alternative {
  id: string
  score: number
  roster: Roster
  warnings: string[]
  stats: MemberStats[]
}

/** Several distinct good rosters, best first. */
export function solveMany(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  opts: SolveOptions & { count?: number } = {},
): { ok: true; alternatives: Alternative[] } | { ok: false; problems: string[] } {
  const want = opts.count ?? 6
  const seen = new Set<string>()
  const alternatives: Alternative[] = []
  const seed0 = opts.seed ?? 1
  for (let k = 0; k < want * 2 && alternatives.length < want; k++) {
    const r = solve(config, responses, { ...opts, seed: seed0 + k * 101 })
    if (!r.ok) return k === 0 ? { ok: false, problems: r.problems } : { ok: true, alternatives }
    const key = r.assignments.map((a) => a.memberId).join(',') + '|' + r.students.map((s) => s.memberId + s.date).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    alternatives.push({
      id: `opt-${seed0 + k * 101}`,
      score: r.score,
      roster: { assignments: r.assignments, students: r.students, presenters: r.presenters },
      warnings: r.warnings,
      stats: r.stats,
    })
  }
  alternatives.sort((a, b) => a.score - b.score)
  return { ok: true, alternatives }
}
