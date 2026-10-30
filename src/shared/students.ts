// Second phase, after residents and staff are fixed:
// - place students onto the shift slots they join, so every resident/staff is on duty with students
//   about equally often (balanced within each type), respecting each student's availability,
//   locks, minimum interval and spread/grouped preference;
// - pick presenters for presentation rules, taking the required number from yesterday's shift first.

import { presentationOn, reqCount, shiftRuns } from './calendar.ts'
import { addDays, dateRange, dayDiff, weekday } from './dates.ts'
import { preferenceCost, responseFor, rng, variance } from './scoring.ts'
import type { Assignment, Member, MemberResponse, PresenterAssignment, SessionConfig, StudentAssignment } from './types.ts'

/** A place students can take: one shift on one date (and, in hospital mode, one job within it). */
export interface Occ {
  i: number
  day: number
  date: string
  shiftId: string
  /** Hospital mode: the shift slot position (job) students fill. */
  requirementId?: string
  jobId?: string
  /** Most students on it. */
  cap: number
  weekend: boolean
  /** Resident/staff member ids on duty in this shift that day. */
  workers: string[]
}

/**
 * Student places. Hospital mode: each shift slot position is a student place (job × count, per date).
 * Generate mode: the shift slots chosen under Students, up to `maxPerShift` each.
 */
export function studentOccs(config: SessionConfig, assignments: Assignment[]): Occ[] {
  const holidays = new Set(config.holidays)
  const occs: Occ[] = []
  dateRange(config.startDate, config.endDate).forEach((date, day) => {
    const wd = weekday(date)
    const weekend = wd === 0 || wd === 6 || holidays.has(date)
    for (const shift of config.shifts) {
      if (!shiftRuns(config, shift, date)) continue
      const workers = assignments.filter((a) => a.date === date && a.shiftId === shift.id).map((a) => a.memberId)
      if (config.rosterMode === 'hospital') {
        for (const req of shift.requirements) {
          const cap = reqCount(config, shift, req, date)
          if (cap > 0) occs.push({ i: occs.length, day, date, shiftId: shift.id, requirementId: req.id, jobId: req.jobId, cap, weekend, workers })
        }
      } else if (config.students.shiftIds.includes(shift.id)) {
        occs.push({ i: occs.length, day, date, shiftId: shift.id, cap: Math.max(1, config.students.maxPerShift), weekend, workers })
      }
    }
  })
  return occs
}

const canDo = (m: Member, o: Occ) => !o.jobId || m.jobs.length === 0 || m.jobs.includes(o.jobId)

export type StudentResult =
  | { ok: true; students: StudentAssignment[]; warnings: string[]; score: number }
  | { ok: false; problems: string[] }

export function arrangeStudents(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  assignments: Assignment[],
  seed = 1,
  iterations = 20_000,
): StudentResult {
  const students = config.members.filter((m) => m.type === 'student')
  const settings = config.students
  if (students.length === 0) return { ok: true, students: [], warnings: [], score: 0 }
  const days = dateRange(config.startDate, config.endDate)
  const occs = studentOccs(config, assignments)
  if (occs.length === 0 || settings.shiftsPerStudent <= 0) {
    return {
      ok: true,
      students: [],
      warnings: [
        config.rosterMode === 'hospital'
          ? 'No student places: add positions (e.g. “Ward × 1”) to a shift slot in Setup.'
          : 'Students are listed but no shift slots are set for them (Setup → Students).',
      ],
      score: 0,
    }
  }
  const need = settings.shiftsPerStudent
  const resp = students.map((s) => responseFor(responses, s.id))
  const allowed = students.map((m, si) => occs.filter((o) => !resp[si].unavailable.includes(o.date) && canDo(m, o)).map((o) => o.i))
  const problems: string[] = []

  // Quick capacity checks.
  const places = occs.reduce((n, o) => n + o.cap, 0)
  if (students.length * need > places) {
    problems.push(`Students need ${students.length * need} shifts but there are only ${places} student places in the period.`)
  }
  students.forEach((s, si) => {
    const gap = resp[si].minInterval
    let n = 0
    let last = -Infinity
    for (const oi of allowed[si]) {
      if (occs[oi].day - last >= gap) {
        n++
        last = occs[oi].day
      }
    }
    if (n < need) problems.push(`${s.name}: only ${n} of ${need} student shifts fit around their unavailable dates and ${gap}-day interval.`)
  })
  if (problems.length) return { ok: false, problems }

  const rand = rng(seed * 7919 + 13)
  // mine[si] = occurrence indexes; load[oi] = students on that occurrence
  let mine: number[][] = []
  let load: number[] = []
  let fixed: Set<string> = new Set()
  const fits = (si: number, oi: number, ignore = -1) =>
    load[oi] < occs[oi].cap &&
    !mine[si].includes(oi) &&
    mine[si].every((x) => x === ignore || Math.abs(occs[x].day - occs[oi].day) >= resp[si].minInterval)
  const add = (si: number, oi: number) => {
    mine[si].push(oi)
    load[oi]++
  }
  const drop = (si: number, oi: number) => {
    mine[si].splice(mine[si].indexOf(oi), 1)
    load[oi]--
  }

  // Greedy placement with a few randomized restarts.
  let placed = false
  const lockIssues: string[] = []
  for (let attempt = 0; attempt < 40 && !placed; attempt++) {
    mine = students.map(() => [])
    load = occs.map(() => 0)
    fixed = new Set()
    lockIssues.length = 0
    students.forEach((s, si) => {
      for (const l of resp[si].locks) {
        const here = occs.filter((x) => x.date === l.date && x.shiftId === l.shiftId && canDo(s, x))
        const o = here.find((x) => fits(si, x.i)) ?? here[0]
        if (!o) lockIssues.push(`${s.name}: locked to a shift students don't join on ${l.date}.`)
        else if (resp[si].unavailable.includes(l.date)) lockIssues.push(`${s.name}: both locked and unavailable on ${l.date}.`)
        else if (!fits(si, o.i)) lockIssues.push(`${s.name}: lock on ${l.date} clashes with another lock or a full shift.`)
        else {
          add(si, o.i)
          fixed.add(`${si}:${o.i}`)
        }
      }
    })
    if (lockIssues.length) return { ok: false, problems: lockIssues }
    placed = true
    for (let round = 0; round < need && placed; round++) {
      const order = students.map((_, si) => si).sort(() => rand() - 0.5)
      for (const si of order) {
        if (mine[si].length > round) continue
        const cands = allowed[si].filter((oi) => fits(si, oi))
        if (cands.length === 0) {
          placed = false
          break
        }
        // Prefer emptier shifts, then random.
        cands.sort((a, b) => load[a] - load[b] + (rand() - 0.5) * 0.9)
        add(si, cands[0])
      }
    }
  }
  if (!placed) {
    return { ok: false, problems: ['Could not fit every student’s required shifts. Try fewer shifts per student, more students per shift, or shorter student intervals.'] }
  }

  // Exposure: how many student-shifts each resident/staff gets.
  const workerIds = config.members.filter((m) => m.type !== 'student').map((m) => m.id)
  const score = () => {
    const exposure = new Map(workerIds.map((id) => [id, 0]))
    occs.forEach((o, oi) => {
      if (load[oi]) for (const w of o.workers) exposure.set(w, (exposure.get(w) ?? 0) + load[oi])
    })
    let sc = 0
    for (const type of ['resident', 'staff'] as const) {
      const ids = config.members.filter((m) => m.type === type).map((m) => m.id)
      sc += 100 * variance(ids.map((id) => exposure.get(id) ?? 0))
    }
    sc += 30 * variance(mine.map((m) => m.filter((oi) => occs[oi].weekend).length))
    mine.forEach((m, si) => {
      sc += preferenceCost(m.map((oi) => occs[oi].day).sort((a, b) => a - b), days.length, resp[si])
    })
    return sc
  }

  // Anneal: move one student-shift to another occurrence.
  let cur = score()
  let temp = 10
  const cool = Math.pow(0.01 / temp, 1 / iterations)
  for (let it = 0; it < iterations; it++, temp *= cool) {
    const si = Math.floor(rand() * students.length)
    if (mine[si].length === 0) continue
    const from = mine[si][Math.floor(rand() * mine[si].length)]
    if (fixed.has(`${si}:${from}`)) continue
    const to = allowed[si][Math.floor(rand() * allowed[si].length)]
    if (to === from || !fits(si, to, from)) continue
    drop(si, from)
    add(si, to)
    const next = score()
    if (next <= cur || rand() < Math.exp((cur - next) / temp)) cur = next
    else {
      drop(si, to)
      add(si, from)
    }
  }

  const out: StudentAssignment[] = []
  mine.forEach((m, si) =>
    m.forEach((oi) =>
      out.push({
        date: occs[oi].date,
        shiftId: occs[oi].shiftId,
        ...(occs[oi].requirementId ? { requirementId: occs[oi].requirementId } : {}),
        memberId: students[si].id,
      }),
    ),
  )
  out.sort((a, b) => a.date.localeCompare(b.date))
  return { ok: true, students: out, warnings: [], score: cur }
}

/** Student-shifts each resident/staff member shares. */
export function studentExposure(config: SessionConfig, assignments: Assignment[], students: StudentAssignment[]) {
  const exposure: Record<string, number> = {}
  for (const s of students) {
    for (const a of assignments) {
      if (a.date === s.date && a.shiftId === s.shiftId) exposure[a.memberId] = (exposure[a.memberId] ?? 0) + 1
    }
  }
  return Object.fromEntries(config.members.filter((m) => m.type !== 'student').map((m) => [m.id, exposure[m.id] ?? 0]))
}

export function pickPresenters(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  assignments: Assignment[],
  students: StudentAssignment[],
  seed = 1,
): { presenters: PresenterAssignment[]; warnings: string[] } {
  const rand = rng(seed * 31 + 7)
  const presenters: PresenterAssignment[] = []
  const warnings: string[] = []
  const count = new Map<string, number>()
  const days = dateRange(config.startDate, config.endDate)
  const available = (id: string, date: string) => !responseFor(responses, id).unavailable.includes(date)
  const byFewest = (ids: string[]) =>
    ids.map((id) => ({ id, k: (count.get(id) ?? 0) + rand() * 0.5 })).sort((a, b) => a.k - b.k).map((x) => x.id)

  for (const rule of config.presentations) {
    const shiftName = config.shifts.find((s) => s.id === rule.fromShiftId)?.name ?? 'that shift'
    const short: string[] = []
    for (const date of days) {
      const today = presentationOn(config, rule, date)
      if (!today) continue
      const yesterday = addDays(date, -1)
      const eligible = config.members.filter((m) => rule.types.includes(m.type) && available(m.id, date)).map((m) => m.id)
      let post: string[] = []
      if (yesterday >= config.startDate) {
        post = [
          ...assignments.filter((a) => a.date === yesterday && a.shiftId === rule.fromShiftId).map((a) => a.memberId),
          ...students.filter((s) => s.date === yesterday && s.shiftId === rule.fromShiftId).map((s) => s.memberId),
        ].filter((id, i, arr) => arr.indexOf(id) === i && eligible.includes(id))
      }
      const chosen = byFewest(post).slice(0, today.fromCount)
      if (chosen.length < today.fromCount && yesterday >= config.startDate) short.push(date)
      for (const id of byFewest(eligible.filter((id) => !chosen.includes(id)))) {
        if (chosen.length >= today.count) break
        chosen.push(id)
      }
      if (chosen.length < today.count) warnings.push(`${date} ${rule.name}: only ${chosen.length} of ${today.count} presenters available.`)
      for (const id of chosen) {
        count.set(id, (count.get(id) ?? 0) + 1)
        presenters.push({ date, ruleId: rule.id, memberId: id, postCall: post.includes(id) })
      }
    }
    if (short.length) {
      warnings.push(
        `${rule.name}: not enough people from the previous ${shiftName} on ${short.length} day(s) (${short.slice(0, 3).join(', ')}${short.length > 3 ? '…' : ''}). Check which member types the rule allows.`,
      )
    }
  }
  return { presenters, warnings }
}

/** Hard-rule checks for students in an edited roster. */
export function validateStudents(config: SessionConfig, responses: Record<string, MemberResponse>, students: StudentAssignment[]): string[] {
  const out: string[] = []
  const occs = studentOccs(config, [])
  const job = (id?: string) => config.jobs.find((j) => j.id === id)?.name ?? ''
  for (const o of occs) {
    const n = students.filter((s) => s.date === o.date && s.shiftId === o.shiftId && (!o.requirementId || s.requirementId === o.requirementId)).length
    if (n > o.cap) out.push(`${o.date}${o.jobId ? ` ${job(o.jobId)}` : ''}: ${n} students, above the limit of ${o.cap}.`)
  }
  for (const s of students) {
    if (!occs.some((o) => o.date === s.date && o.shiftId === s.shiftId && (!o.requirementId || !s.requirementId || o.requirementId === s.requirementId))) {
      out.push(`${config.members.find((m) => m.id === s.memberId)?.name ?? '?'} is on ${s.date}, which has no student place.`)
    }
  }
  for (const m of config.members.filter((x) => x.type === 'student')) {
    const r = responseFor(responses, m.id)
    const dates = students.filter((s) => s.memberId === m.id).map((s) => s.date).sort()
    for (const d of dates) if (r.unavailable.includes(d)) out.push(`${m.name} (student) is unavailable on ${d}.`)
    for (let i = 1; i < dates.length; i++) {
      if (dayDiff(dates[i - 1], dates[i]) < r.minInterval) out.push(`${m.name} (student): ${dates[i - 1]} and ${dates[i]} are closer than ${r.minInterval} days.`)
    }
  }
  return out
}

// ---------- hospital mode: options and counting for students only ----------

export interface StudentOption {
  id: string
  score: number
  roster: { assignments: Assignment[]; students: StudentAssignment[]; presenters: PresenterAssignment[] }
  warnings: string[]
}

/** Several distinct student arrangements around a fixed resident/staff roster, best first. */
export function studentOptions(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  assignments: Assignment[],
  opts: { seed?: number; count?: number } = {},
): { ok: true; alternatives: StudentOption[] } | { ok: false; problems: string[] } {
  const want = opts.count ?? 6
  const seed0 = opts.seed ?? 1
  const seen = new Set<string>()
  const out: StudentOption[] = []
  for (let k = 0; k < want * 3 && out.length < want; k++) {
    const seed = seed0 + k * 101
    const r = arrangeStudents(config, responses, assignments, seed)
    if (!r.ok) return k === 0 ? { ok: false, problems: r.problems } : { ok: true, alternatives: out }
    const key = r.students.map((x) => `${x.memberId}${x.date}${x.shiftId}`).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    const p = pickPresenters(config, responses, assignments, r.students, seed)
    out.push({ id: `st-${seed}`, score: r.score, roster: { assignments, students: r.students, presenters: p.presenters }, warnings: [...r.warnings, ...p.warnings] })
  }
  out.sort((a, b) => a.score - b.score)
  return { ok: true, alternatives: out }
}

/**
 * How many ways students can be placed (availability, locks, intervals, shifts each, places per shift).
 * Exact by enumeration when small, otherwise a Knuth random-probe estimate.
 */
export function countStudentArrangements(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  opts: { nodeLimit?: number; probes?: number; seed?: number } = {},
): { exact: true; count: number } | { exact: false; log10: number } {
  const students = config.members.filter((m) => m.type === 'student')
  const st = config.students
  const occs = studentOccs(config, config.duty)
  if (!students.length || !occs.length || st.shiftsPerStudent <= 0) return { exact: true, count: students.length ? 0 : 1 }
  const resp = students.map((m) => responseFor(responses, m.id))
  const need = st.shiftsPerStudent
  const load = occs.map(() => 0)
  const locks = students.map((_, si) =>
    resp[si].locks
      .map((l) => occs.findIndex((o) => o.date === l.date && o.shiftId === l.shiftId && canDo(students[si], o)))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b),
  )
  const free = (si: number, i: number) => load[i] < occs[i].cap && !resp[si].unavailable.includes(occs[i].date) && canDo(students[si], occs[i])
  /** Most further picks possible after occurrence i (greedy earliest is optimal for spacing). */
  const room = (si: number, i: number) => {
    let n = 0
    let lastDay = occs[i].day
    for (let j = i + 1; j < occs.length; j++) {
      if (free(si, j) && occs[j].day - lastDay >= resp[si].minInterval) {
        n++
        lastDay = occs[j].day
      }
    }
    return n
  }
  // Each student's picks are an increasing list of occurrence indexes, so every set is counted once.
  // Choices that can't lead to a full set (no room left, or skipping a lock) are pruned; that keeps the
  // random estimate unbiased while making far fewer probes dead-end.
  const options = (si: number, picked: number[]) => {
    const last = picked.length ? picked[picked.length - 1] : -1
    const lockNext = locks[si].find((l) => !picked.includes(l))
    const locksLeft = locks[si].filter((l) => !picked.includes(l)).length
    const left = need - picked.length
    return occs
      .map((_, i) => i)
      .filter((i) => {
        if (i <= last || !free(si, i)) return false
        if (picked.length && occs[i].day - occs[picked[picked.length - 1]].day < resp[si].minInterval) return false
        if (lockNext !== undefined && i > lockNext) return false
        if (left === locksLeft && lockNext !== undefined && i !== lockNext) return false
        return room(si, i) >= left - 1
      })
  }
  const complete = (si: number, picked: number[]) => picked.length === need && locks[si].every((l) => picked.includes(l))

  let nodes = 0
  const limit = opts.nodeLimit ?? 80_000
  let total = 0
  const walk = (si: number, picked: number[]): boolean => {
    if (++nodes > limit) return false
    if (si === students.length) {
      total++
      return true
    }
    if (picked.length === need) return complete(si, picked) ? walk(si + 1, []) : true
    for (const i of options(si, picked)) {
      load[i]++
      const ok = walk(si, [...picked, i])
      load[i]--
      if (!ok) return false
    }
    return true
  }
  if (walk(0, [])) return { exact: true, count: total }

  load.fill(0)
  const rand = rng(opts.seed ?? 5)
  const logs: number[] = []
  for (let k = 0; k < (opts.probes ?? 4000); k++) {
    load.fill(0)
    let log = 0
    let dead = false
    for (let si = 0; si < students.length && !dead; si++) {
      const picked: number[] = []
      while (picked.length < need) {
        const o = options(si, picked)
        if (!o.length) {
          dead = true
          break
        }
        log += Math.log10(o.length)
        const i = o[Math.floor(rand() * o.length)]
        picked.push(i)
        load[i]++
      }
      if (!dead && !complete(si, picked)) dead = true
    }
    logs.push(dead ? -Infinity : log)
  }
  const finite = logs.filter(Number.isFinite)
  if (!finite.length) return { exact: false, log10: Number.NaN }
  const max = Math.max(...finite)
  const mean = finite.reduce((a, l) => a + 10 ** (l - max), 0) / logs.length
  return { exact: false, log10: max + Math.log10(mean) }
}

// ---------- hand-arranging students in a preview ----------

/** Key of a student place cell in the roster table. */
export const placeKey = (x: { date: string; shiftId: string; requirementId?: string }) => `${x.date}|${x.shiftId}|${x.requirementId ?? ''}`

/** Rule problems per student place cell, so the table can mark exactly where a hand-made change breaks something. */
export function studentCellIssues(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  students: StudentAssignment[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (key: string, msg: string) => out.set(key, [...(out.get(key) ?? []), msg])
  const occs = studentOccs(config, [])
  for (const o of occs) {
    const here = students.filter((s) => s.date === o.date && s.shiftId === o.shiftId && (s.requirementId ?? '') === (o.requirementId ?? ''))
    if (here.length > o.cap) add(placeKey(o), `${here.length} students here, the limit is ${o.cap}.`)
  }
  for (const m of config.members.filter((x) => x.type === 'student')) {
    const r = responseFor(responses, m.id)
    const mine = students.filter((s) => s.memberId === m.id).sort((a, b) => a.date.localeCompare(b.date))
    for (const s of mine) {
      if (r.unavailable.includes(s.date)) add(placeKey(s), `${m.name} is unavailable this day.`)
      const o = occs.find((x) => x.date === s.date && x.shiftId === s.shiftId && (x.requirementId ?? '') === (s.requirementId ?? ''))
      if (!o) add(placeKey(s), `${m.name}: there’s no student place here.`)
      else if (!canDo(m, o)) add(placeKey(s), `${m.name} doesn’t cover this job.`)
    }
    for (let i = 1; i < mine.length; i++) {
      const gap = dayDiff(mine[i - 1].date, mine[i].date)
      if (gap < r.minInterval) {
        const msg = `${m.name}: ${mine[i - 1].date} and ${mine[i].date} are closer than their ${r.minInterval}-day interval.`
        add(placeKey(mine[i - 1]), msg)
        add(placeKey(mine[i]), msg)
      }
    }
    for (const l of r.locks) {
      if (!mine.some((s) => s.date === l.date && s.shiftId === l.shiftId)) {
        const o = occs.find((x) => x.date === l.date && x.shiftId === l.shiftId)
        if (o) add(placeKey(o), `${m.name} locked this shift but isn’t on it.`)
      }
    }
  }
  if (students.length) {
    const need = config.students.shiftsPerStudent
    for (const m of config.members.filter((x) => x.type === 'student')) {
      const n = students.filter((s) => s.memberId === m.id).length
      if (n !== need) {
        const first = students.find((s) => s.memberId === m.id)
        if (first) add(placeKey(first), `${m.name} has ${n} shifts, not ${need}.`)
      }
    }
  }
  return out
}

/**
 * Where a picked-up student could go without breaking a rule: places with room ('move'),
 * and other students they could trade places with ('swap', keyed by the other student's place + id).
 */
export function studentTargets(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  students: StudentAssignment[],
  from: StudentAssignment,
): { moves: Set<string>; swaps: Set<string> } {
  const occs = studentOccs(config, [])
  const member = (id: string) => config.members.find((m) => m.id === id)
  const ok = (memberId: string, to: Occ, leaving: StudentAssignment, also?: StudentAssignment) => {
    const m = member(memberId)
    if (!m) return false
    const r = responseFor(responses, memberId)
    if (r.unavailable.includes(to.date) || !canDo(m, to)) return false
    // Leaving a locked shift breaks the lock.
    if (r.locks.some((l) => l.date === leaving.date && l.shiftId === leaving.shiftId) && !(to.date === leaving.date && to.shiftId === leaving.shiftId)) return false
    const others = students.filter((s) => s.memberId === memberId && s !== leaving && s !== also)
    return others.every((s) => Math.abs(dayDiff(s.date, to.date)) >= r.minInterval)
  }
  const fromOcc = occs.find((o) => o.date === from.date && o.shiftId === from.shiftId && (o.requirementId ?? '') === (from.requirementId ?? ''))
  const moves = new Set<string>()
  const swaps = new Set<string>()
  for (const o of occs) {
    if (placeKey(o) === placeKey(from)) continue
    const here = students.filter((s) => s.date === o.date && s.shiftId === o.shiftId && (s.requirementId ?? '') === (o.requirementId ?? ''))
    if (here.length < o.cap && ok(from.memberId, o, from)) moves.add(placeKey(o))
    if (!fromOcc) continue
    for (const b of here) {
      if (b.memberId === from.memberId) continue
      if (ok(from.memberId, o, from, b) && ok(b.memberId, fromOcc, b, from)) swaps.add(`${placeKey(o)}|${b.memberId}`)
    }
  }
  return { moves, swaps }
}
