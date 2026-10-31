// Second phase, after residents and staff are fixed:
// - place students onto the shift slots they join, so every resident/staff is on duty with students
//   about equally often (balanced within each type), respecting each student's availability,
//   locks, minimum interval and spread/grouped preference;
// - pick presenters for presentation rules, taking the required number from yesterday's shift first.

import { fmtPoints, presentationOn, reqCount, reqMin, shiftPoints, shiftRuns, shiftSpan, shiftTimes, sourceMatches, sourceOffsets } from './calendar.ts'
import { t, weekdayShort } from './i18n.ts'
import { addDays, dateRange, dayDiff, weekday } from './dates.ts'
import { preferenceCost, responseFor, rng, shuffled, sortedBy, variance } from './scoring.ts'
import { coversJob, dutyOf, isOneDay, jobsOn, presentationPoints, presenterTypes, type PresenterSource, type Assignment, type Member, type MemberResponse, type PresenterAssignment, type SessionConfig, type StudentAssignment } from './types.ts'

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
  /** Fewest students it must have. */
  min: number
  weekend: boolean
  /** Points a student earns here (1 when points are off). */
  pts: number
  /** Start and end in minutes from the first day, so shifts longer than a day can't overlap. */
  startMin: number
  endMin: number
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
      const pts = shiftPoints(config, shift.id, date)
      const span = shiftSpan(shift)
      const startMin = day * 1440 + span.start
      const endMin = day * 1440 + span.end
      if (config.rosterMode === 'hospital') {
        for (const req of shift.requirements) {
          const cap = reqCount(config, shift, req, date)
          const min = reqMin(config, shift, req, date)
          if (cap > 0) occs.push({ i: occs.length, day, date, shiftId: shift.id, requirementId: req.id, jobId: req.jobId, cap, min, weekend, pts, startMin, endMin, workers })
        }
      } else if (config.students.shiftIds.includes(shift.id)) {
        occs.push({ i: occs.length, day, date, shiftId: shift.id, cap: Math.max(1, config.students.maxPerShift), min: 0, weekend, pts, startMin, endMin, workers })
      }
    }
  })
  return occs
}

/** Do two shifts overlap in time (only possible when one lasts into a later day)? */
const overlaps = (a: Occ, b: Occ) => a.startMin < b.endMin && b.startMin < a.endMin

const canDo = (m: Member, o: Occ) => coversJob(m, o.jobId, o.date)

/** Penalty for working a date someone asked to avoid, by level (second to keeping points fair and within the limit). */
export const AVOID_PENALTY = [0, 150, 800, 3000]
const REPEAT_RESIDENT_PENALTY = 400

const REPEAT_STAFF_PENALTY = 300
const REPEAT_PARTNER_PENALTY = 350
const ALONE_PENALTY = 150
/** Per run of three shifts each two days apart (on duty every other day). */
const ALTERNATE_PENALTY = 600

/** Runs of three shifts each two days apart, e.g. Mon–Wed–Fri (days as sorted day numbers). */
export function everyOtherDay(days: number[]) {
  let n = 0
  for (let i = 2; i < days.length; i++) if (days[i] - days[i - 1] === 2 && days[i - 1] - days[i - 2] === 2) n++
  return n
}

/** Per shift more than one apart between two students of a group, in one type of shift. */
const SLOT_SPREAD_PENALTY = 8000

/** Per point above the host's limit on how far apart students' points may be. */
const POINTS_OVER_PENALTY = 5000

/** How many points the spread (most − fewest) is above `maxDiff` percent of the average; 0 when within it or no limit. */
export function pointsOver(pts: number[], maxDiff?: number) {
  if (!maxDiff || pts.length < 2) return 0
  const avg = pts.reduce((a, b) => a + b, 0) / pts.length
  return Math.max(0, Math.max(...pts) - Math.min(...pts) - (avg * maxDiff) / 100)
}

/** Exact count per shift slot for each student, when the host set one; null = a single total. */
export function slotQuota(config: SessionConfig): Map<string, number> | null {
  if (config.students.auto) return null
  const q = Object.entries(config.students.perSlot ?? {}).filter(([id, n]) => n > 0 && config.shifts.some((s) => s.id === id))
  return q.length ? new Map(q) : null
}

/**
 * "Share equally": `total` student-shifts (by default every place filled up to its "at most"), split
 * between the students — `base` each, and `extra` of them one more.
 */
export function equalShare(config: SessionConfig, total = studentOccs(config, []).reduce((n, o) => n + o.cap, 0)) {
  const n = config.members.filter((m) => m.type === 'student').length
  return { total, base: n ? Math.floor(total / n) : 0, extra: n ? total % n : 0 }
}

/**
 * Students who can take the same places, joined up (by "Can cover" and places by dates). Sharing equally
 * happens within each group: two rotations that never share a ward each split their own ward's places.
 * Usually there's one group, everyone.
 */
export function shareGroups(config: SessionConfig, occs = studentOccs(config, [])): { members: number[]; places: number }[] {
  const students = config.members.filter((m) => m.type === 'student')
  const parent = students.map((_, i) => i)
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])))
  const covers = students.map((m) => occs.filter((o) => coversJob(m, o.jobId, o.date)).map((o) => o.i))
  const first = new Map<number, number>()
  covers.forEach((list, si) =>
    list.forEach((oi) => {
      const other = first.get(oi)
      if (other === undefined) first.set(oi, si)
      else parent[root(si)] = root(other)
    }),
  )
  const groups = new Map<number, number[]>()
  students.forEach((_, si) => groups.set(root(si), [...(groups.get(root(si)) ?? []), si]))
  return [...groups.values()].map((members) => ({
    members,
    places: [...new Set(members.flatMap((si) => covers[si]))].reduce((n, oi) => n + occs[oi].cap, 0),
  }))
}

/** `total` student-shifts split between groups by their places (largest remainder), never above a group's places. */
function splitTotal(groups: { places: number }[], total: number): number[] {
  const places = groups.reduce((n, g) => n + g.places, 0)
  if (!places) return groups.map(() => 0)
  const raw = groups.map((g) => (Math.min(total, places) * g.places) / places)
  const out = raw.map(Math.floor)
  let left = Math.min(total, places) - out.reduce((a, b) => a + b, 0)
  for (const gi of sortedBy(groups.map((_, i) => i), (i) => out[i] - raw[i])) {
    if (left <= 0) break
    if (out[gi] < groups[gi].places) {
      out[gi]++
      left--
    }
  }
  return out
}

/** Sharing equally: each student's [fewest, most] shifts, sharing `total` within their group. */
export function equalTargets(config: SessionConfig, total?: number, occs = studentOccs(config, [])): [number, number][] {
  const groups = shareGroups(config, occs)
  const totals = splitTotal(groups, total ?? occs.reduce((n, o) => n + o.cap, 0))
  const out: [number, number][] = config.members.filter((m) => m.type === 'student').map(() => [0, 0])
  groups.forEach((g, gi) => {
    const base = Math.floor(totals[gi] / g.members.length)
    const hi = base + (totals[gi] % g.members.length ? 1 : 0)
    for (const si of g.members) out[si] = [base, hi]
  })
  return out
}

/** Most shifts each student can fit in their allowed places, keeping their gap (earliest-first is optimal). */
export function fitCounts(occs: Occ[], allowed: number[][], gaps: number[]): number[] {
  return allowed.map((list, si) => {
    let n = 0
    let last: Occ | null = null
    for (const oi of list) {
      if (!last || (occs[oi].day - last.day >= gaps[si] && !overlaps(last, occs[oi]))) {
        n++
        last = occs[oi]
      }
    }
    return n
  })
}

/** Sharing equally, the most student-shifts that fit: nobody does more than one above the least available student. */
function equalMost(fit: number[]) {
  const fewest = Math.min(...fit)
  return fit.length * fewest + fit.filter((n) => n > fewest).length
}

/**
 * Sharing equally with everyone's answers: all the places, how many can be shared out fairly (an upper
 * bound), and who limits it when that's fewer.
 */
export function equalShareFor(config: SessionConfig, responses: Record<string, MemberResponse>) {
  const students = config.members.filter((m) => m.type === 'student')
  const occs = studentOccs(config, [])
  const places = occs.reduce((n, o) => n + o.cap, 0)
  const resp = students.map((m) => studentResponse(config, responses, m.id))
  const allowed = students.map((m, si) => occs.filter((o) => !resp[si].unavailable.includes(o.date) && canDo(m, o)).map((o) => o.i))
  const fit = fitCounts(occs, allowed, resp.map((r) => r.minInterval))
  const groups = shareGroups(config, occs)
  const total = students.length ? groups.reduce((n, g) => n + Math.min(g.places, equalMost(g.members.map((si) => fit[si]))), 0) : places
  const fewest = Math.min(...fit)
  // With groups that take different places, each shares its own: the overall range of shifts each.
  const targets = equalTargets(config, total, occs)
  const range: [number, number] = targets.length ? [Math.min(...targets.map(([lo]) => lo)), Math.max(...targets.map(([, hi]) => hi))] : [0, 0]
  return {
    places,
    ...equalShare(config, total),
    groups: groups.length,
    range,
    limited: total < places ? { name: students[fit.indexOf(fewest)].name, k: fewest } : null,
  }
}

/** Shifts each student does in total (the most anyone does, when sharing equally). */
export function shiftsNeeded(config: SessionConfig): number {
  if (config.students.auto) return Math.max(0, ...equalTargets(config).map(([, hi]) => hi))
  const q = slotQuota(config)
  return q ? [...q.values()].reduce((a, b) => a + b, 0) : config.students.shiftsPerStudent
}

/** A student's answers with the host's minimum gap applied. */
export function studentResponse(config: SessionConfig, responses: Record<string, MemberResponse>, id: string): MemberResponse {
  const r = responseFor(responses, id)
  const gap = config.students.minGap ?? 0
  return gap > r.minInterval ? { ...r, minInterval: gap } : r
}

export function avoidLevel(r: MemberResponse, date: string): number {
  return r.avoid?.find((a) => a.date === date)?.level ?? 0
}

export type StudentResult =
  | { ok: true; students: StudentAssignment[]; warnings: string[]; score: number }
  | { ok: false; problems: string[] }

export function arrangeStudents(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  assignments: Assignment[],
  seed = 1,
  iterations = 20_000,
  /** Points each student already has from presenting (member id -> points), when presentations count towards points. */
  extraPoints: Record<string, number> = {},
): StudentResult {
  const students = config.members.filter((m) => m.type === 'student')
  const settings = config.students
  if (students.length === 0) return { ok: true, students: [], warnings: [], score: 0 }
  const days = dateRange(config.startDate, config.endDate)
  const occs = studentOccs(config, assignments)
  const quota = slotQuota(config)
  if (occs.length === 0 || shiftsNeeded(config) <= 0) {
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
  const auto = Boolean(settings.auto)
  const need = shiftsNeeded(config)
  const resp = students.map((s) => studentResponse(config, responses, s.id))
  const allowed = students.map((m, si) =>
    occs.filter((o) => !resp[si].unavailable.includes(o.date) && canDo(m, o) && (!quota || (quota.get(o.shiftId) ?? 0) > 0)).map((o) => o.i),
  )
  const problems: string[] = []

  // Quick capacity checks.
  const places = occs.reduce((n, o) => n + o.cap, 0)
  const minimum = occs.reduce((n, o) => n + o.min, 0)
  if (!auto && students.length * need > places) {
    problems.push(t('Students need {n} shifts but there are only {p} student places in the period.', { n: students.length * need, p: places }))
  }
  if (quota) {
    for (const [shiftId, n] of quota) {
      const os = occs.filter((o) => o.shiftId === shiftId)
      const cap = os.reduce((a, o) => a + o.cap, 0)
      const min = os.reduce((a, o) => a + o.min, 0)
      const name = config.shifts.find((x) => x.id === shiftId)?.name ?? ''
      if (students.length * n > cap) problems.push(t('{shift}: students need {n} places but there are only {cap}.', { shift: name, n: students.length * n, cap }))
      if (students.length * n < min) problems.push(t('{shift}: every day needs its minimum ({min} in total), but students only do {n}.', { shift: name, min, n: students.length * n }))
    }
  }
  if (!auto && students.length * need < minimum) {
    problems.push(t('Every place needs at least its minimum ({min} student-shifts in total), but students only do {n}. Add students or shifts per student, or lower the minimums.', { min: minimum, n: students.length * need }))
  }
  for (const o of occs) {
    if (o.min > 0 && students.filter((_, si) => allowed[si].includes(o.i)).length < o.min) {
      const shift = config.shifts.find((x) => x.id === o.shiftId)?.name ?? ''
      problems.push(t('{date} {shift}: needs {n} student(s) but not enough are available.', { date: o.date, shift, n: o.min }))
    }
  }
  // Most shifts each student can fit around their unavailable dates and gap.
  const fitMax = fitCounts(occs, allowed, resp.map((r) => r.minInterval))
  students.forEach((s, si) => {
    const n = fitMax[si]
    const gap = resp[si].minInterval
    if (!auto && n < need) problems.push(t('{name}: only {n} of {need} shifts fit around their unavailable dates and {gap}-day gap.', { name: s.name, n, need, gap }))
  })
  if (problems.length) return { ok: false, problems }

  // Places a presentation takes its presenters from, with the dates those presenters present: someone
  // who's ✕ that day shouldn't take the place, or the presentation may be short (e.g. the only one on a night).
  const presentsOn = new Map<number, string[]>()
  // The same places by type of presentation (each weekly one, and one-day ones together): shifts that lead to
  // presenting are spread evenly too, so presentations can be shared out evenly afterwards.
  const presentKinds = new Map<string, Set<number>>()
  for (const rule of config.presentations) {
    const kind = isOneDay(rule) ? 'one-day' : rule.id
    if (!presentKinds.has(kind)) presentKinds.set(kind, new Set())
    for (const date of days) {
      const today = presentationOn(config, rule, date)
      if (!today) continue
      for (const src of today.sources) {
        if (!src.count) continue
        for (const n of sourceOffsets(src, today.daysBack)) {
          const day = addDays(date, -n)
          for (const o of occs) {
            if (o.date !== day || !sourceMatches(config, src, o.shiftId, o.requirementId)) continue
            presentsOn.set(o.i, [...(presentsOn.get(o.i) ?? []), date])
            presentKinds.get(kind)!.add(o.i)
          }
        }
      }
    }
  }
  const rand = rng(seed * 7919 + 13)
  // Shifts each student does. Sharing equally, the students with the most open places take the extra
  // ones (with a random tie-break, so each option shares them differently).
  let needs = students.map(() => need)
  // Within each group of students who can take the same places (see shareGroups).
  const groups = shareGroups(config, occs)
  const shareOut = (total: number) => {
    const totals = splitTotal(groups, total)
    needs = students.map(() => 0)
    groups.forEach((g, gi) => {
      const base = Math.floor(totals[gi] / g.members.length)
      const order = sortedBy(g.members, (si) => -allowed[si].length + (rand() - 0.5) * 6)
      for (const si of g.members) needs[si] = base
      for (const si of order.slice(0, totals[gi] % g.members.length)) needs[si]++
    })
  }
  // mine[si] = occurrence indexes; load[oi] = students on that occurrence
  let mine: number[][] = []
  let load: number[] = []
  let fixed: Set<string> = new Set()
  const spaced = (si: number, oi: number, ignore = -1) =>
    !mine[si].includes(oi) &&
    mine[si].every((x) => x === ignore || (Math.abs(occs[x].day - occs[oi].day) >= resp[si].minInterval && !overlaps(occs[x], occs[oi])))
  // With per-slot counts, a student takes no more of a shift slot than their quota.
  const slotRoom = (si: number, oi: number) =>
    !quota || mine[si].filter((x) => occs[x].shiftId === occs[oi].shiftId).length < (quota.get(occs[oi].shiftId) ?? 0)
  const fits = (si: number, oi: number, ignore = -1) => load[oi] < occs[oi].cap && spaced(si, oi, ignore) && (ignore >= 0 || slotRoom(si, oi))
  const add = (si: number, oi: number) => {
    mine[si].push(oi)
    load[oi]++
  }
  const drop = (si: number, oi: number) => {
    mine[si].splice(mine[si].indexOf(oi), 1)
    load[oi]--
  }

  // Greedy placement with a few randomized restarts. Sharing equally, if every place can't be filled,
  // try again with one student-shift fewer at a time (places above their minimum may stay empty).
  let placed = false
  const lockIssues: string[] = []
  // Sharing equally, nobody can do more than one shift above the least available student.
  const fewest = Math.min(...fitMax)
  const limited = students[fitMax.indexOf(fewest)]
  const most = groups.reduce((n, g) => n + Math.min(g.places, equalMost(g.members.map((si) => fitMax[si]))), 0)
  let total = auto ? Math.min(places, most) : places
  for (let tries = 0; ; tries++) {
    if (auto) shareOut(total)
    for (let attempt = 0; attempt < 40 && !placed; attempt++) {
      mine = students.map(() => [])
      load = occs.map(() => 0)
      fixed = new Set()
      lockIssues.length = 0
      students.forEach((s, si) => {
        for (const l of resp[si].locks) {
          const here = occs.filter((x) => x.date === l.date && x.shiftId === l.shiftId && canDo(s, x))
          const o = here.find((x) => fits(si, x.i)) ?? here[0]
          if (!o) lockIssues.push(t('{name}: locked to a shift with no student place on {date}.', { name: s.name, date: l.date }))
          else if (resp[si].unavailable.includes(l.date)) lockIssues.push(t('{name}: both locked and unavailable on {date}.', { name: s.name, date: l.date }))
          else if (!fits(si, o.i)) lockIssues.push(t('{name}: lock on {date} clashes with another lock or a full shift.', { name: s.name, date: l.date }))
          else {
            add(si, o.i)
            fixed.add(`${si}:${o.i}`)
          }
        }
      })
      if (lockIssues.length) return { ok: false, problems: lockIssues }
      placed = true
      // First give every place its minimum (sharing equally: fill it), hardest-to-fill places first.
      const target = (o: Occ) => (auto ? o.cap : o.min)
      // Filling every place is a tight packing: go day by day, like a rotation, rather than hardest first.
      const short = occs
        .filter((o) => target(o) > 0)
        .map((o) => ({ o, k: auto ? o.day + rand() * 0.5 : students.filter((_, si) => allowed[si].includes(o.i)).length + rand() }))
        .sort((a, b) => a.k - b.k)
      for (const { o } of short) {
        while (placed && load[o.i] < target(o)) {
          const cands = students.map((_, si) => si).filter((si) => mine[si].length < needs[si] && allowed[si].includes(o.i) && fits(si, o.i))
          if (cands.length) add(sortedBy(cands, (si) => mine[si].length - needs[si] + (rand() - 0.5) * 0.9)[0], o.i)
          else if (load[o.i] < o.min) placed = false
          else break
        }
      }
      for (let round = 0; round < Math.max(...needs) && placed; round++) {
        const order = shuffled(students.map((_, si) => si), rand)
        for (const si of order) {
          if (mine[si].length > round || mine[si].length >= needs[si]) continue
          const cands = allowed[si].filter((oi) => fits(si, oi))
          if (cands.length === 0) {
            placed = false
            break
          }
          // Prefer places still under their minimum, then emptier ones, then random.
          add(si, sortedBy(cands, (oi) => (load[oi] < occs[oi].min ? -10 : 0) + load[oi] + (rand() - 0.5) * 0.9)[0])
        }
      }
      if (placed && occs.some((o) => load[o.i] < o.min)) placed = false
    }
    if (placed || !auto || tries >= 3 * students.length) break
    // At the minimums there's nothing to leave empty: share the extra shifts out differently and try again.
    if (total <= minimum) {
      if (tries >= 8) break
    } else total--
  }
  if (!placed) {
    return {
      ok: false,
      problems: [t('Could not fit every student’s shifts while giving every place its minimum. Try fewer shifts per student, more students per shift, lower minimums, or shorter gaps.')],
    }
  }

  // Exposure: how many student-shifts each resident/staff gets.
  const workerIds = config.members.filter((m) => m.type !== 'student').map((m) => m.id)
  const residentIds = new Set(config.members.filter((m) => m.type === 'resident').map((m) => m.id))
  const staffIds = new Set(config.members.filter((m) => m.type === 'staff').map((m) => m.id))
  const noRepeat = settings.avoidRepeatResident ?? false
  const noRepeatStaff = settings.avoidRepeatStaff ?? false
  const noRepeatPartner = settings.avoidRepeatPartner ?? false
  const wantPartner = settings.wantPartner ?? false
  const room = (oi: number) => `${occs[oi].date}|${occs[oi].shiftId}`
  const slotIds = [...new Set(occs.map((o) => o.shiftId))]
  const pointsOn = Boolean(settings.points?.on)
  const score = () => {
    // Who shares each room (date + shift slot), for partner rules.
    const together = new Map<string, number[]>()
    if (noRepeatPartner || wantPartner) {
      mine.forEach((m, si) => m.forEach((oi) => together.set(room(oi), [...(together.get(room(oi)) ?? []), si])))
    }
    const exposure = new Map(workerIds.map((id) => [id, 0]))
    occs.forEach((o, oi) => {
      if (load[oi]) for (const w of o.workers) exposure.set(w, (exposure.get(w) ?? 0) + load[oi])
    })
    let sc = 0
    for (const type of ['resident', 'staff'] as const) {
      const ids = config.members.filter((m) => m.type === type).map((m) => m.id)
      sc += 100 * variance(ids.map((id) => exposure.get(id) ?? 0))
    }
    if (pointsOn) {
      const pts = mine.map((m, si) => m.reduce((n, oi) => n + occs[oi].pts, extraPoints[students[si].id] ?? 0))
      sc += 80 * variance(pts)
      // The host's limit on how far apart points may be, far above every other wish: everyone outside the
      // band around the average counts (not just the two ends), so each step towards it is rewarded.
      const limit = settings.points?.maxDiff
      if (limit) {
        const avg = pts.reduce((a, b) => a + b, 0) / pts.length
        const half = (avg * limit) / 200
        for (const p of pts) sc += POINTS_OVER_PENALTY * Math.max(0, Math.abs(p - avg) - half)
        sc += POINTS_OVER_PENALTY * pointsOver(pts, limit)
      }
    }
    else sc += 30 * variance(mine.map((m) => m.filter((oi) => occs[oi].weekend).length))
    // Shifts presenters come from, spread evenly by type of presentation.
    for (const places of presentKinds.values()) {
      if (!places.size) continue
      const n = mine.map((m) => m.filter((oi) => places.has(oi)).length)
      sc += 300 * variance(n)
      // Everyone gets at least one chance at each type, when there are enough to go round.
      if (places.size >= students.length) sc += 400 * n.filter((k) => k === 0).length
    }
    // Each type of shift (slot) shared evenly within each group of students who take the same places: everyone
    // gets about as many of the long shifts (e.g. overnight) as the others, at most one apart — unless someone with
    // fewer makes up for it elsewhere (as many points as the group's average).
    const loads = pointsOn ? mine.map((m, si) => m.reduce((n, oi) => n + occs[oi].pts, extraPoints[students[si].id] ?? 0)) : null
    for (const id of slotIds) {
      const n = mine.map((m) => m.filter((oi) => occs[oi].shiftId === id).length)
      sc += 40 * variance(n)
      for (const g of groups) {
        // "Always even" types: at most 1 apart if at all possible; if not, made up for in points, still at a cost.
        const even = settings.evenSlots?.includes(id)
        const u = unevenParts(g.members.map((si) => n[si]), loads ? g.members.map((si) => loads[si]) : null)
        sc += SLOT_SPREAD_PENALTY * (u.uncovered + (even ? EVEN_SOFT_SHARE * (u.short - u.uncovered) : 0))
      }
    }
    mine.forEach((m, si) => {
      const ds = m.map((oi) => occs[oi].day).sort((a, b) => a - b)
      sc += preferenceCost(ds, days.length, resp[si])
      // On duty every other day three times running (e.g. Mon–Wed–Fri) is exhausting.
      sc += ALTERNATE_PENALTY * everyOtherDay(ds)
      for (const oi of m) sc += AVOID_PENALTY[avoidLevel(resp[si], occs[oi].date)]
      if (noRepeat || noRepeatStaff) {
        const seen = new Set<string>()
        for (const oi of m) {
          for (const w of new Set(occs[oi].workers)) {
            if (seen.has(w)) {
              if (noRepeat && residentIds.has(w)) sc += REPEAT_RESIDENT_PENALTY
              if (noRepeatStaff && staffIds.has(w)) sc += REPEAT_STAFF_PENALTY
            }
            seen.add(w)
          }
        }
      }
      if (noRepeatPartner || wantPartner) {
        const partners = m.flatMap((oi) => (together.get(room(oi)) ?? []).filter((x) => x !== si))
        if (noRepeatPartner) sc += (REPEAT_PARTNER_PENALTY * (partners.length - new Set(partners).size)) / 2
        if (wantPartner && m.length > 1 && partners.length === 0) sc += ALONE_PENALTY
      }
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
    if (rand() < 0.6) {
      // Move to another place, never leaving `from` below its minimum (and within the same slot when counts are per slot).
      const to = allowed[si][Math.floor(rand() * allowed[si].length)]
      if (to === from || load[from] - 1 < occs[from].min || !fits(si, to, from)) continue
      if (quota && occs[to].shiftId !== occs[from].shiftId) continue
      drop(si, from)
      add(si, to)
      const next = score()
      if (next <= cur || rand() < Math.exp((cur - next) / temp)) cur = next
      else {
        drop(si, to)
        add(si, from)
      }
    } else {
      // Trade places with another student (keeps every place's count, so minimums hold): a place this student
      // may take, with whoever is on it — so trades stay within students who can take the same places.
      const to = allowed[si][Math.floor(rand() * allowed[si].length)]
      const there = students.map((_, j) => j).filter((j) => j !== si && mine[j].includes(to))
      if (!there.length) continue
      const sj = there[Math.floor(rand() * there.length)]
      if (to === from || fixed.has(`${sj}:${to}`) || !allowed[sj].includes(from)) continue
      if (quota && occs[to].shiftId !== occs[from].shiftId) continue
      if (!spaced(si, to, from) || !spaced(sj, from, to)) continue
      drop(si, from)
      drop(sj, to)
      add(si, to)
      add(sj, from)
      const next = score()
      if (next <= cur || rand() < Math.exp((cur - next) / temp)) cur = next
      else {
        drop(si, to)
        drop(sj, from)
        add(si, from)
        add(sj, to)
      }
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
  const warnings =
    auto && total < places
      ? [
          most < places
            ? t('{n} student place(s) stay empty: {name} can only fit {k} shifts, and everyone does about the same.', { n: places - total, name: limited.name, k: fewest })
            : t('{n} student place(s) stay empty — with everyone’s unavailable dates and minimum gaps, they can’t all be filled.', { n: places - total }),
        ]
      : []
  return { ok: true, students: out, warnings, score: cur }
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
  // With presentations counting towards points, everyone starts from their shift points, so whoever has
  // lighter shifts presents more.
  const start: Record<string, number> = {}
  if (presentationsCount(config)) for (const s of students) start[s.memberId] = (start[s.memberId] ?? 0) + shiftPoints(config, s.shiftId, s.date)
  // A few tries from different random starts; the most even one wins (fewest people short or twice in a day first).
  let best: { presenters: PresenterAssignment[]; warnings: string[]; cost: number } | null = null
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = pickPresentersOnce(config, responses, assignments, students, seed + attempt * 1000, start)
    if (!best || r.cost < best.cost) best = r
  }
  return { presenters: best!.presenters, warnings: best!.warnings }
}

function pickPresentersOnce(
  config: SessionConfig,
  _responses: Record<string, MemberResponse>,
  assignments: Assignment[],
  students: StudentAssignment[],
  seed: number,
  start: Record<string, number>,
): { presenters: PresenterAssignment[]; warnings: string[]; cost: number } {
  const rand = rng(seed * 31 + 7)
  const warnings: string[] = []
  const days = dateRange(config.startDate, config.endDate)
  // Shared out evenly in total and by type: each weekly presentation is a type, one-day ones are one type together.
  const kind = (ruleId: string) => {
    const rule = config.presentations.find((r) => r.id === ruleId)!
    return isOneDay(rule) ? 'one-day' : rule.id
  }
  const total = new Map<string, number>(Object.entries(start))
  const byKind = new Map<string, number>()
  // Totals count each presentation by its points (a one-day one counts double by default); types by number.
  const weight = (k: string, ruleId?: string) => presentationPoints(config.presentations.find((r) => r.id === ruleId) ?? config.presentations.find((r) => kind(r.id) === k)!)
  const bump = (id: string, k: string, d: number, ruleId?: string) => {
    total.set(id, (total.get(id) ?? 0) + d * weight(k, ruleId))
    byKind.set(`${k}|${id}`, (byKind.get(`${k}|${id}`) ?? 0) + d)
  }
  // Even totals come first: someone short of one type (e.g. one-day ones, tied to a few nights) makes it up in
  // another (e.g. morning reports). Then even within each type.
  // Everyone presents at each weekly presentation (e.g. morning report) at least once: whoever hasn't yet goes first.
  const firstTurn = (id: string, k: string) => k !== 'one-day' && !(byKind.get(`${k}|${id}`) ?? 0)
  const load = (id: string, k: string) => 2 * (total.get(id) ?? 0) + (byKind.get(`${k}|${id}`) ?? 0) - (firstTurn(id, k) ? 1000 : 0)
  const byFewest = (ids: string[], k: string) => sortedBy(ids, (id) => load(id, k) + rand() * 0.5)

  /** One presenter place: who could take it (`pool`) and who did. */
  type Slot = { date: string; ruleId: string; kind: string; pool: string[]; lastNight: string[]; who: string }
  const slots: Slot[] = []
  const short = new Map<string, Set<string>>()
  // Day by day across all presentations, the one-day ones (fewest chances) first.
  const order = sortedBy(config.presentations, (r) => (isOneDay(r) ? 0 : 1))
  for (const date of days) {
    for (const rule of order) {
      const today = presentationOn(config, rule, date)
      if (!today) continue
      const k = kind(rule.id)
      const types = presenterTypes(config, rule)
      // ✕ only rules out shifts: someone unavailable for duty that day can still present.
      const eligible = config.members.filter((m) => types.includes(m.type)).map((m) => m.id)
      const chosen: string[] = []
      // Nobody presents twice in a day: people already presenting today come last, only when nobody else can.
      const busy = new Set(slots.filter((x) => x.date === date).map((x) => x.who))
      // Rather not: presenting the day before (two days in a row), or on a weekday they asked not to present.
      const loath = (id: string) => slots.some((x) => x.who === id && (x.date === addDays(date, -1) || x.date === addDays(date, -2)))
      const take = (pool: string[], lastNight: string[], n: number) => {
        const free = pool.filter((x) => !chosen.includes(x))
        const tiers = [free.filter((x) => !busy.has(x) && !loath(x)), free.filter((x) => !busy.has(x) && loath(x)), free.filter((x) => busy.has(x))]
        for (const id of tiers.flatMap((tier) => byFewest(tier, k)).slice(0, n)) {
          chosen.push(id)
          bump(id, k, 1, rule.id)
          slots.push({ date, ruleId: rule.id, kind: k, pool, lastNight, who: id })
        }
      }
      // Each source first: e.g. one presenter from each ward of last night's shift (or of 2–3 days before).
      for (const src of today.sources) {
        const back = sourceOffsets(src, today.daysBack).map((n) => addDays(date, -n))
        if (src.count === 0) continue
        if (back.every((d) => d < config.startDate)) {
          // Nobody was on duty before the roster starts (e.g. the morning of its first day): a source for one
          // ward still takes someone covering that ward that day, so each ward gets its presenter.
          const ward = sourceJob(config, src)
          if (ward) {
            const members = config.members.filter((m) => eligible.includes(m.id) && coversJob(m, ward, date))
            take(members.map((m) => m.id), [], src.count)
          }
          continue
        }
        const on = (d: string) =>
          [...assignments, ...students].filter((x) => x.date === d && sourceMatches(config, src, x.shiftId, x.requirementId)).map((x) => x.memberId)
        const pool = [...new Set(back.flatMap(on))].filter((id) => eligible.includes(id))
        const before = chosen.length
        // ● marks presenting straight after a night on: only someone who was on it last night.
        take(pool, src.when === 'same' ? [] : on(addDays(date, -1)), src.count)
        // Not enough (e.g. the only one on it can't come): someone else from the same ward — on duty then first,
        // else covering that ward that day — so each ward still gets its share.
        const ward = sourceJob(config, src)
        if (ward && chosen.length - before < src.count) {
          const wardOf = (x: StudentAssignment) => config.shifts.find((sh) => sh.id === x.shiftId)?.requirements.find((r) => r.id === x.requirementId)?.jobId
          // Never someone already presenting that day or the day before: a stand-in is only worth it when free.
          const fine = (id: string) => eligible.includes(id) && !busy.has(id) && !loath(id)
          const onDuty = [...new Set(students.filter((x) => back.includes(x.date) && wardOf(x) === ward).map((x) => x.memberId))].filter(fine)
          take(onDuty, onDuty, src.count - (chosen.length - before))
          const covering = config.members.filter((m) => fine(m.id) && coversJob(m, ward, date)).map((m) => m.id)
          if (chosen.length - before < src.count) take(covering, [], src.count - (chosen.length - before))
        }
        if (chosen.length - before < src.count) short.set(rule.id, (short.get(rule.id) ?? new Set()).add(date))
      }
      take(eligible, [], today.count - chosen.length)
      if (chosen.length < today.count) warnings.push(t('{date} {rule}: only {n} of {need} presenters available.', { date, rule: rule.name, n: chosen.length, need: today.count }))
    }
  }

  // Even it out: hand a place to someone else who could take it whenever that makes the counts more even.
  const cost = (id: string, k: string) => 3 * (total.get(id) ?? 0) ** 2 + (byKind.get(`${k}|${id}`) ?? 0) ** 2 + (firstTurn(id, k) ? 500 : 0)
  for (let pass = 0; pass < 20; pass++) {
    let better = false
    for (const slot of slots) {
      // Not someone already in this presentation, or presenting anything else that day.
      // Not someone presenting that day, the day before or after, or on a weekday they'd rather not present.
      const taken = new Set(slots.filter((x) => Math.abs(dayDiff(x.date, slot.date)) <= 2).map((x) => x.who))
      let best: string | null = null
      let gain = 0
      for (const id of slot.pool) {
        if (taken.has(id)) continue
        // Moving this place from its presenter to `id`: how much more even does it get?
        const now = cost(slot.who, slot.kind) + cost(id, slot.kind)
        bump(slot.who, slot.kind, -1, slot.ruleId)
        bump(id, slot.kind, 1, slot.ruleId)
        const after = cost(slot.who, slot.kind) + cost(id, slot.kind)
        bump(id, slot.kind, -1, slot.ruleId)
        bump(slot.who, slot.kind, 1, slot.ruleId)
        if (now - after > gain) {
          gain = now - after
          best = id
        }
      }
      if (best) {
        bump(slot.who, slot.kind, -1, slot.ruleId)
        bump(best, slot.kind, 1, slot.ruleId)
        slot.who = best
        better = true
      }
    }
    if (!better) break
  }

  // Anyone who still presents twice in a day (nobody else could): say so.
  for (const date of days) {
    const ids = slots.filter((x) => x.date === date).map((x) => x.who)
    for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) {
      warnings.push(t('{date}: {name} presents twice — nobody else could.', { date, name: config.members.find((m) => m.id === id)?.name ?? '?' }))
    }
  }
  const presenters: PresenterAssignment[] = sortedBy(slots, (x) => days.indexOf(x.date)).map((x) => ({
    date: x.date,
    ruleId: x.ruleId,
    memberId: x.who,
    postCall: x.lastNight.includes(x.who),
  }))
  for (const rule of config.presentations) {
    const dates = [...(short.get(rule.id) ?? [])]
    if (dates.length) {
      warnings.push(
        t('{rule}: not enough of the people it must include on {n} day(s) ({dates}).', { rule: rule.name, n: dates.length, dates: `${dates.slice(0, 3).join(', ')}${dates.length > 3 ? '…' : ''}` }),
      )
    }
  }
  const spread = [...total.values()].reduce((n, v) => n + 3 * v * v, 0) + [...byKind.values()].reduce((n, v) => n + v * v, 0)
  return { presenters, warnings, cost: 1000 * warnings.length + spread }
}

/** Hard-rule checks for students in an edited roster. */
export function validateStudents(config: SessionConfig, responses: Record<string, MemberResponse>, students: StudentAssignment[]): string[] {
  const out: string[] = []
  const occs = studentOccs(config, [])
  const job = (id?: string) => config.jobs.find((j) => j.id === id)?.name ?? ''
  for (const o of occs) {
    const n = students.filter((s) => s.date === o.date && s.shiftId === o.shiftId && (!o.requirementId || s.requirementId === o.requirementId)).length
    if (n > o.cap) out.push(t('{place}: {n} students, above the limit of {cap}.', { place: `${o.date}${o.jobId ? ` ${job(o.jobId)}` : ''}`, n, cap: o.cap }))
  }
  for (const s of students) {
    if (!occs.some((o) => o.date === s.date && o.shiftId === s.shiftId && (!o.requirementId || !s.requirementId || o.requirementId === s.requirementId))) {
      out.push(t('{name} is on {date}, which has no student place.', { name: config.members.find((m) => m.id === s.memberId)?.name ?? '?', date: s.date }))
    }
  }
  for (const m of config.members.filter((x) => x.type === 'student')) {
    const r = studentResponse(config, responses, m.id)
    const dates = students.filter((s) => s.memberId === m.id).map((s) => s.date).sort()
    for (const d of dates) if (r.unavailable.includes(d)) out.push(t('{name} is unavailable on {date}.', { name: m.name, date: d }))
    for (let i = 1; i < dates.length; i++) {
      if (dayDiff(dates[i - 1], dates[i]) < r.minInterval) out.push(t('{name}: {a} and {b} are closer than {gap} days.', { name: m.name, a: dates[i - 1], b: dates[i], gap: r.minInterval }))
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
  // Three times as many to choose from as are shown, so the best fits can be picked.
  const candidates = want * 3
  for (let k = 0; k < candidates * 3 && out.length < candidates; k++) {
    const seed = seed0 + k * 101
    const r = arrangeStudents(config, responses, assignments, seed)
    if (!r.ok) return k === 0 ? { ok: false, problems: r.problems } : { ok: true, alternatives: out }
    const key = r.students.map((x) => `${x.memberId}${x.date}${x.shiftId}`).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    let p = pickPresenters(config, responses, assignments, r.students, seed)
    let placed = r
    if (presentationsCount(config)) {
      // Presenting counts towards points: arrange again knowing who presents how much, pick presenters again, and
      // keep that only if it's no worse — each type of shift as even, then points fairer.
      const again = arrangeStudents(config, responses, assignments, seed, undefined, presentationLoad(config, p.presenters))
      if (again.ok) {
        const p2 = pickPresenters(config, responses, assignments, again.students, seed)
        const rank = (st: StudentAssignment[], pr: PresenterAssignment[]) => {
          const r = studentRuleReport(config, responses, { assignments, students: st, presenters: pr })
          return [typeSpread(config, st, pr), r.pointsOk ? 0 : 1, r.pointsSpread]
        }
        const [a, b] = [rank(placed.students, p.presenters), rank(again.students, p2.presenters)]
        const i = a.findIndex((x, k) => x !== b[k])
        if (i >= 0 && b[i] < a[i]) {
          placed = again
          p = p2
        }
      }
    }
    out.push({ id: `st-${seed}`, score: placed.score, roster: { assignments, students: placed.students, presenters: p.presenters }, warnings: [...placed.warnings, ...p.warnings] })
  }
  // Best fits first. Those that satisfy both — points within the limit and every avoid request met, then within
  // the limit with no !!! missed — and after them, fairest points first (within the limit, then the closest),
  // then fewest avoid requests not met (!!! before !! before !), then the arranger's own score.
  const fit = new Map(
    out.map((o) => {
      const r = studentRuleReport(config, responses, o.roster)
      const missed = r.avoidHits[1] + r.avoidHits[2] + r.avoidHits[3]
      const both = r.pointsOk && missed === 0 ? 0 : r.pointsOk && r.avoidHits[3] === 0 ? 1 : 2
      // Everyone at morning report (each weekly presentation) at least once comes before all else, then each type of
      // shift shared out evenly (at most one apart within a group).
      const p = o.roster.presenters
      const twice = p.filter((x, i) => p.findIndex((y) => y.date === x.date && y.memberId === x.memberId) !== i).length
      return [o, [r.missingWeekly.length + twice + presentsInARow(p).length, typeSpread(config, o.roster.students, o.roster.presenters), both, r.pointsOk ? 0 : 1, r.pointsSpread, r.avoidHits[3], r.avoidHits[2], r.avoidHits[1], o.score]] as const
    }),
  )
  out.sort((a, b) => {
    const [x, y] = [fit.get(a)!, fit.get(b)!]
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  })
  return { ok: true, alternatives: out.slice(0, want) }
}

/** The ward (job) a presenter source is about, if any: its place's job, or the job it names. */
export function sourceJob(config: SessionConfig, src: PresenterSource): string | undefined {
  if (src.jobId) return src.jobId
  if (!src.placeId) return undefined
  return config.shifts.find((x) => x.id === src.shiftId)?.requirements.find((r) => r.id === src.placeId)?.jobId || undefined
}

/** How unevenly each type of shift is shared: in each group, for each shift slot, shifts beyond one apart. */
export function typeSpread(config: SessionConfig, students: StudentAssignment[], presenters?: PresenterAssignment[]) {
  const studs = config.members.filter((m) => m.type === 'student')
  const load = loadPoints(config, students, presenters)
  let over = 0
  for (const g of shareGroups(config)) {
    for (const sh of config.shifts) {
      const n = g.members.map((si) => students.filter((x) => x.memberId === studs[si].id && x.shiftId === sh.id).length)
      const u = unevenParts(n, load ? g.members.map((si) => load[studs[si].id] ?? 0) : null)
      // Not made up for counts fully; made up for in an "always even" type counts a little (at most 1 apart is better).
      over += u.uncovered + (config.students.evenSlots?.includes(sh.id) ? EVEN_SOFT_SHARE * (u.short - u.uncovered) : 0)
    }
  }
  return over
}

/**
 * How unevenly one type of shift is shared in a group: for each student more than one below the most anyone has,
 * how far — unless they make up for it elsewhere (their points, with presentations when those count, are at least
 * the group's average). `points` null = no points, so nothing can make up for it.
 */
export function unevenType(counts: number[], points: number[] | null) {
  return unevenParts(counts, points).uncovered
}

/** The same, in two parts: `short` = all shifts beyond one apart; `uncovered` = those not made up for in points. */
export function unevenParts(counts: number[], points: number[] | null) {
  if (!counts.length) return { short: 0, uncovered: 0 }
  const most = Math.max(...counts)
  const avg = points ? points.reduce((a, b) => a + b, 0) / points.length : 0
  let short = 0
  let uncovered = 0
  counts.forEach((k, i) => {
    const s = most - k - 1
    if (s <= 0) return
    short += s
    if (!(points && points[i] >= avg)) uncovered += s
  })
  return { short, uncovered }
}

/** "Always even" shift types: made up for in points is acceptable, but at most 1 apart is better by this much. */
const EVEN_SOFT_SHARE = 0.3

/** Each student's points as the host counts them (shifts, plus presentations when they count); null when points are off. */
function loadPoints(config: SessionConfig, students: StudentAssignment[], presenters?: PresenterAssignment[]): Record<string, number> | null {
  if (!config.students.points?.on) return null
  const out: Record<string, number> = presentationsCount(config) && presenters ? { ...presentationLoad(config, presenters) } : {}
  for (const x of students) out[x.memberId] = (out[x.memberId] ?? 0) + shiftPoints(config, x.shiftId, x.date)
  return out
}

/** Do presentations count towards points (points on, and the host chose so)? */
export const presentationsCount = (config: SessionConfig) => Boolean(config.students.points?.on && config.students.points.presentations)

/** Points each person has from presenting: member id -> sum of their presentations' points. */
export function presentationLoad(config: SessionConfig, presenters: PresenterAssignment[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of presenters) {
    const rule = config.presentations.find((r) => r.id === p.ruleId)
    if (rule) out[p.memberId] = (out[p.memberId] ?? 0) + presentationPoints(rule)
  }
  return out
}

/**
 * How many ways students can be placed (availability, locks, intervals, shifts each, places per shift).
 * Exact by enumeration when small, otherwise a Knuth random-probe estimate.
 */
export function countStudentArrangements(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  opts: { nodeLimit?: number; probes?: number; seed?: number; ms?: number } = {},
): { exact: true; count: number } | { exact: false; log10: number } {
  const students = config.members.filter((m) => m.type === 'student')
  const occs = studentOccs(config, dutyOf(config))
  if (!students.length || !occs.length || shiftsNeeded(config) <= 0) return { exact: true, count: students.length ? 0 : 1 }
  const resp = students.map((m) => studentResponse(config, responses, m.id))
  const quota = slotQuota(config)
  // Sharing equally, count one way of giving out the extra shifts (to the students with the most open
  // places) and scale by the number of ways to choose them — an estimate, so it's reported as one.
  const allowed = students.map((m, si) => occs.filter((o) => !resp[si].unavailable.includes(o.date) && canDo(m, o)).map((o) => o.i))
  const places = occs.reduce((n, o) => n + o.cap, 0)
  const share = config.students.auto
    ? equalShare(config, Math.min(places, equalMost(fitCounts(occs, allowed, resp.map((r) => r.minInterval)))))
    : null
  const needs = students.map(() => shiftsNeeded(config))
  if (share) {
    const open = allowed.map((a) => a.length)
    const order = students.map((_, si) => si).sort((a, b) => open[b] - open[a])
    needs.fill(share.base)
    for (const si of order.slice(0, share.extra)) needs[si]++
  }
  const ways = share ? Math.log10(binomial(students.length, share.extra)) : 0
  const load = occs.map(() => 0)
  const locks = students.map((_, si) =>
    resp[si].locks
      .map((l) => occs.findIndex((o) => o.date === l.date && o.shiftId === l.shiftId && canDo(students[si], o)))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b),
  )
  const free = (si: number, i: number) =>
    load[i] < occs[i].cap && !resp[si].unavailable.includes(occs[i].date) && canDo(students[si], occs[i]) && (!quota || (quota.get(occs[i].shiftId) ?? 0) > 0)
  /** Most further picks possible after occurrence i (greedy earliest is optimal for spacing). */
  const room = (si: number, i: number) => {
    let n = 0
    let last = occs[i]
    for (let j = i + 1; j < occs.length; j++) {
      if (free(si, j) && occs[j].day - last.day >= resp[si].minInterval && !overlaps(last, occs[j])) {
        n++
        last = occs[j]
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
    const left = needs[si] - picked.length
    return occs
      .map((_, i) => i)
      .filter((i) => {
        if (i <= last || !free(si, i)) return false
        const prev = picked.length ? occs[picked[picked.length - 1]] : null
        if (prev && (occs[i].day - prev.day < resp[si].minInterval || overlaps(prev, occs[i]))) return false
        if (lockNext !== undefined && i > lockNext) return false
        if (left === locksLeft && lockNext !== undefined && i !== lockNext) return false
        if (quota && picked.filter((x) => occs[x].shiftId === occs[i].shiftId).length >= (quota.get(occs[i].shiftId) ?? 0)) return false
        return room(si, i) >= left - 1
      })
  }
  const complete = (si: number, picked: number[]) => picked.length === needs[si] && locks[si].every((l) => picked.includes(l))

  let nodes = 0
  const limit = opts.nodeLimit ?? 80_000
  // Big rotations: stop exploring after a few seconds and estimate from what was sampled.
  const deadline = Date.now() + (opts.ms ?? 3000)
  let total = 0
  const walk = (si: number, picked: number[]): boolean => {
    if (++nodes > limit || (nodes % 1024 === 0 && Date.now() > deadline)) return false
    if (si === students.length) {
      if (occs.every((o, i) => load[i] >= o.min)) total++
      return true
    }
    if (picked.length === needs[si]) return complete(si, picked) ? walk(si + 1, []) : true
    for (const i of options(si, picked)) {
      load[i]++
      const ok = walk(si, [...picked, i])
      load[i]--
      if (!ok) return false
    }
    return true
  }
  if (walk(0, [])) return share?.extra ? { exact: false, log10: total ? Math.log10(total) + ways : Number.NaN } : { exact: true, count: total }

  load.fill(0)
  const rand = rng(opts.seed ?? 5)
  const logs: number[] = []
  for (let k = 0; k < (opts.probes ?? 4000) && (k < 100 || Date.now() < deadline); k++) {
    load.fill(0)
    let log = 0
    let dead = false
    for (let si = 0; si < students.length && !dead; si++) {
      const picked: number[] = []
      while (picked.length < needs[si]) {
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
    if (!dead && occs.some((o, i) => load[i] < o.min)) dead = true
    logs.push(dead ? -Infinity : log)
  }
  const finite = logs.filter(Number.isFinite)
  if (!finite.length) return { exact: false, log10: Number.NaN }
  const max = Math.max(...finite)
  const mean = finite.reduce((a, l) => a + 10 ** (l - max), 0) / logs.length
  return { exact: false, log10: max + Math.log10(mean) + ways }
}

function binomial(n: number, k: number) {
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return r
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
    if (here.length > o.cap) add(placeKey(o), t('{n} students here, the limit is {cap}.', { n: here.length, cap: o.cap }))
    if (here.length < o.min) add(placeKey(o), t('Needs at least {min} student(s), has {n}.', { min: o.min, n: here.length }))
  }
  for (const m of config.members.filter((x) => x.type === 'student')) {
    const r = studentResponse(config, responses, m.id)
    const mine = students.filter((s) => s.memberId === m.id).sort((a, b) => a.date.localeCompare(b.date))
    for (const s of mine) {
      if (r.unavailable.includes(s.date)) add(placeKey(s), t('{name} is unavailable this day.', { name: m.name }))
      const o = occs.find((x) => x.date === s.date && x.shiftId === s.shiftId && (x.requirementId ?? '') === (s.requirementId ?? ''))
      if (!o) add(placeKey(s), t('{name}: there’s no student place here.', { name: m.name }))
      else if (!canDo(m, o)) {
        const dated = (m.periods ?? []).find((p) => p.from <= s.date && s.date <= p.to)
        const place = config.jobs.find((j) => j.id === dated?.jobId)?.name
        add(placeKey(s), place ? t('{name} is in {place} on this date.', { name: m.name, place }) : t('{name} doesn’t cover this job.', { name: m.name }))
      }
    }
    const occOf = (s: StudentAssignment) => occs.find((x) => x.date === s.date && x.shiftId === s.shiftId && (x.requirementId ?? '') === (s.requirementId ?? ''))
    for (let i = 1; i < mine.length; i++) {
      const gap = dayDiff(mine[i - 1].date, mine[i].date)
      const [a, b] = [occOf(mine[i - 1]), occOf(mine[i])]
      if (a && b && overlaps(a, b)) {
        const msg = t('{name}: the shifts on {a} and {b} overlap.', { name: m.name, a: mine[i - 1].date, b: mine[i].date })
        add(placeKey(mine[i - 1]), msg)
        add(placeKey(mine[i]), msg)
      } else if (gap < r.minInterval) {
        const msg = t('{name}: {a} and {b} are closer than {gap} days.', { name: m.name, a: mine[i - 1].date, b: mine[i].date, gap: r.minInterval })
        add(placeKey(mine[i - 1]), msg)
        add(placeKey(mine[i]), msg)
      }
    }
    for (const l of r.locks) {
      if (!mine.some((s) => s.date === l.date && s.shiftId === l.shiftId)) {
        const o = occs.find((x) => x.date === l.date && x.shiftId === l.shiftId)
        if (o) add(placeKey(o), t('{name} locked this shift but isn’t on it.', { name: m.name }))
      }
    }
  }
  const quota = slotQuota(config)
  if (quota && students.length) {
    for (const m of config.members.filter((x) => x.type === 'student')) {
      for (const [shiftId, n] of quota) {
        const mine = students.filter((s) => s.memberId === m.id && s.shiftId === shiftId)
        if (mine.length !== n && mine[0]) {
          add(placeKey(mine[0]), t('{name} has {n} × {shift}, should be {need}.', { name: m.name, n: mine.length, shift: config.shifts.find((x) => x.id === shiftId)?.name ?? '', need: n }))
        }
      }
    }
  }
  if (students.length && config.students.auto) {
    // Whatever was placed, nobody should have more than one shift more than anyone else in their group.
    const all = config.members.filter((x) => x.type === 'student')
    const count = (si: number) => students.filter((s) => s.memberId === all[si].id).length
    for (const g of shareGroups(config, occs)) {
      const placed = g.members.reduce((n, si) => n + count(si), 0)
      const base = Math.floor(placed / g.members.length)
      const extra = placed % g.members.length
      for (const si of g.members) {
        const n = count(si)
        const first = students.find((s) => s.memberId === all[si].id)
        if ((n < base || n > base + (extra ? 1 : 0)) && first) {
          add(placeKey(first), t('{name} has {n} shifts; an equal share is {share}.', { name: all[si].name, n, share: extra ? `${base}–${base + 1}` : base }))
        }
      }
    }
  } else if (students.length) {
    const need = shiftsNeeded(config)
    for (const m of config.members.filter((x) => x.type === 'student')) {
      const n = students.filter((s) => s.memberId === m.id).length
      if (n !== need) {
        const first = students.find((s) => s.memberId === m.id)
        if (first) add(placeKey(first), t('{name} has {n} shifts, not {need}.', { name: m.name, n, need }))
      }
    }
  }
  return out
}

/** One change the repair makes: two students trade places (each takes the other's shift). */
export interface RepairSwap {
  a: StudentAssignment
  b: StudentAssignment
}

/**
 * Fix a roster with as few changes as possible: trade places between two students (only trades the hand-arranging
 * rules allow), one at a time, taking the trade that helps most — each type of shift shared evenly first, then
 * fewer missed avoid requests, then fairer points — preferring trades on the same day (nobody's dates change).
 * Stops when no trade helps enough to be worth making. Presenters are re-picked only on days whose night before
 * changed.
 */
export function repairRoster(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  roster: { assignments: Assignment[]; students: StudentAssignment[]; presenters: PresenterAssignment[] },
  most = 40,
): { students: StudentAssignment[]; presenters: PresenterAssignment[]; swaps: RepairSwap[]; presenterDays: string[] } {
  const studs = config.members.filter((m) => m.type === 'student')
  const index = new Map(studs.map((m, i) => [m.id, i]))
  const groups = shareGroups(config)
  const groupOf = new Map<number, number[]>()
  for (const g of groups) for (const si of g.members) groupOf.set(si, g.members)
  const resp = new Map(studs.map((m) => [m.id, studentResponse(config, responses, m.id)]))
  let cur = roster.students.map((x) => ({ ...x }))
  // Shifts of each type per student, and points per student.
  const count = new Map<string, number>()
  const key = (id: string, slot: string) => `${id}|${slot}`
  for (const x of cur) count.set(key(x.memberId, x.shiftId), (count.get(key(x.memberId, x.shiftId)) ?? 0) + 1)
  // Points as the host counts them: shifts, plus presentations when they count.
  const pts = new Map<string, number>(presentationsCount(config) ? Object.entries(presentationLoad(config, roster.presenters)) : [])
  for (const x of cur) pts.set(x.memberId, (pts.get(x.memberId) ?? 0) + shiftPoints(config, x.shiftId, x.date))
  const spreadOf = (id: string, slot: string) => {
    const g = groupOf.get(index.get(id)!) ?? []
    // Made up for in points counts (a little for "always even" types); every type is looked at for each trade, as
    // trades move points around.
    const u = unevenParts(
      g.map((si) => count.get(key(studs[si].id, slot)) ?? 0),
      config.students.points?.on ? g.map((si) => pts.get(studs[si].id) ?? 0) : null,
    )
    return u.uncovered + (config.students.evenSlots?.includes(slot) ? EVEN_SOFT_SHARE * (u.short - u.uncovered) : 0)
  }
  const avoidCost = (id: string, date: string) => AVOID_PENALTY[avoidLevel(resp.get(id)!, date)]
  /** How much a trade of places between a and b improves things (bigger is better). */
  const gain = (a: StudentAssignment, b: StudentAssignment) => {
    const slots = [...new Set([a.shiftId, b.shiftId])]
    const ids = [a.memberId, b.memberId]
    // Both are in the same group (only they can trade), so the group's figure covers them both — for every type,
    // since a trade changes points, which decide whether fewer of some other type is made up for.
    const every = config.students.points?.on ? config.shifts.map((sh) => sh.id) : slots
    const spreadBefore = every.reduce((n, sl) => n + spreadOf(ids[0], sl), 0)
    const bump = (d: number) => {
      count.set(key(a.memberId, a.shiftId), (count.get(key(a.memberId, a.shiftId)) ?? 0) - d)
      count.set(key(a.memberId, b.shiftId), (count.get(key(a.memberId, b.shiftId)) ?? 0) + d)
      count.set(key(b.memberId, b.shiftId), (count.get(key(b.memberId, b.shiftId)) ?? 0) - d)
      count.set(key(b.memberId, a.shiftId), (count.get(key(b.memberId, a.shiftId)) ?? 0) + d)
    }
    bump(1)
    const shift = (d: number) => {
      pts.set(a.memberId, (pts.get(a.memberId) ?? 0) + d * (shiftPoints(config, b.shiftId, b.date) - shiftPoints(config, a.shiftId, a.date)))
      pts.set(b.memberId, (pts.get(b.memberId) ?? 0) + d * (shiftPoints(config, a.shiftId, a.date) - shiftPoints(config, b.shiftId, b.date)))
    }
    shift(1)
    const spreadAfter = every.reduce((n, sl) => n + spreadOf(ids[0], sl), 0)
    shift(-1)
    bump(-1)
    const avoid = avoidCost(a.memberId, a.date) + avoidCost(b.memberId, b.date) - avoidCost(a.memberId, b.date) - avoidCost(b.memberId, a.date)
    // On duty every other day, three times running: before and after the trade, for both of them.
    const runs = (id: string, out: string, inn: string) =>
      everyOtherDay(
        [...cur.filter((x) => x.memberId === id).map((x) => x.date).filter((d) => d !== out), inn]
          .map((d) => dayDiff(config.startDate, d))
          .sort((p, q) => p - q),
      )
    const alternate =
      a.date === b.date ? 0 : ALTERNATE_PENALTY * (runs(a.memberId, '', a.date) + runs(b.memberId, '', b.date) - runs(a.memberId, a.date, b.date) - runs(b.memberId, b.date, a.date))
    const pa = shiftPoints(config, a.shiftId, a.date)
    const pb = shiftPoints(config, b.shiftId, b.date)
    const [x, y] = [pts.get(a.memberId) ?? 0, pts.get(b.memberId) ?? 0]
    const points = x * x + y * y - ((x - pa + pb) ** 2 + (y - pb + pa) ** 2)
    // The host's points limit counts as much here as when arranging.
    const limit = config.students.points?.on ? config.students.points.maxDiff : undefined
    const all = () => studs.map((m) => pts.get(m.id) ?? 0)
    const overBefore = limit ? pointsOver(all(), limit) : 0
    pts.set(a.memberId, x - pa + pb)
    pts.set(b.memberId, y - pb + pa)
    const overAfter = limit ? pointsOver(all(), limit) : 0
    pts.set(a.memberId, x)
    pts.set(b.memberId, y)
    // Each trade costs a little (more across days), so only worthwhile ones are made.
    return 100_000 * (spreadBefore - spreadAfter + overBefore - overAfter) + avoid + alternate + 40 * points - (a.date === b.date ? 30 : 120)
  }
  const swaps: RepairSwap[] = []
  for (let n = 0; n < most; n++) {
    let best: { a: StudentAssignment; b: StudentAssignment; g: number } | null = null
    for (const a of cur) {
      const { swaps: legal } = studentTargets(config, responses, cur, a)
      for (const k of legal) {
        const memberId = k.slice(k.lastIndexOf('|') + 1)
        const place = k.slice(0, k.lastIndexOf('|'))
        const b = cur.find((x) => x.memberId === memberId && placeKey(x) === place)
        // Each pair once (from the student listed later); trades are allowed both ways or neither.
        if (!b || b.memberId === a.memberId || index.get(b.memberId)! > index.get(a.memberId)!) continue
        const g = gain(a, b)
        if (g > 0 && (!best || g > best.g)) best = { a, b, g }
      }
    }
    if (!best) break
    const { a, b } = best
    swaps.push({ a: { ...a }, b: { ...b } })
    // Apply: a takes b's place and b takes a's.
    count.set(key(a.memberId, a.shiftId), (count.get(key(a.memberId, a.shiftId)) ?? 0) - 1)
    count.set(key(a.memberId, b.shiftId), (count.get(key(a.memberId, b.shiftId)) ?? 0) + 1)
    count.set(key(b.memberId, b.shiftId), (count.get(key(b.memberId, b.shiftId)) ?? 0) - 1)
    count.set(key(b.memberId, a.shiftId), (count.get(key(b.memberId, a.shiftId)) ?? 0) + 1)
    const [pa, pb] = [shiftPoints(config, a.shiftId, a.date), shiftPoints(config, b.shiftId, b.date)]
    pts.set(a.memberId, (pts.get(a.memberId) ?? 0) - pa + pb)
    pts.set(b.memberId, (pts.get(b.memberId) ?? 0) - pb + pa)
    const placeA = { date: a.date, shiftId: a.shiftId, requirementId: a.requirementId }
    const placeB = { date: b.date, shiftId: b.shiftId, requirementId: b.requirementId }
    cur = cur.map((x) => (x === a ? { ...placeB, memberId: a.memberId } : x === b ? { ...placeA, memberId: b.memberId } : x))
  }
  // Presenters: keep them, except on days where one of them no longer fits — someone who had to come off a
  // shift the night before (or that day) and was moved off it. Those days are picked again.
  const changedNights = new Set(swaps.flatMap((x) => [x.a.date, x.b.date]))
  const stillFits = (p: PresenterAssignment) => {
    const rule = config.presentations.find((r) => r.id === p.ruleId)
    const today = rule && presentationOn(config, rule, p.date)
    if (!today || !today.sources.length) return true
    const was = (st: StudentAssignment[]) =>
      today.sources.some((src) =>
        sourceOffsets(src, today.daysBack).some((n) =>
          st.some((x) => x.memberId === p.memberId && x.date === addDays(p.date, -n) && sourceMatches(config, src, x.shiftId, x.requirementId)),
        ),
      )
    // Only those who were picked for a source (they were on its shift) must still be on it.
    return !was(roster.students) || was(cur)
  }
  // Re-pick only the presentations (on those days) where someone no longer fits; keep all others.
  const nearChanges = new Set([...changedNights].flatMap((d) => [d, addDays(d, 1)]))
  const redo = new Set(roster.presenters.filter((p) => nearChanges.has(p.date) && !stillFits(p)).map((p) => `${p.date}|${p.ruleId}`))
  const wardRedo = new Set<string>()
  // Also any presentation breaking a presenter rule: two days in a row, twice in a day, a weekday they'd rather
  // not, or not the share each ward (rotation group) should give.
  // Two days in a row, or every other day: either day may be the one to change.
  for (const gap of [1, 2] as const) {
    for (const x of presentsInARow(roster.presenters, gap)) {
      for (const p of roster.presenters.filter((q) => q.memberId === x.memberId && (q.date === x.date || q.date === addDays(x.date, -gap)))) {
        redo.add(`${p.date}|${p.ruleId}`)
      }
    }
  }
  roster.presenters.forEach((p, i) => {
    if (roster.presenters.findIndex((q) => q.date === p.date && q.memberId === p.memberId) !== i) redo.add(`${p.date}|${p.ruleId}`)
  })
  for (const k of new Set(roster.presenters.map((p) => `${p.date}|${p.ruleId}`))) {
    const [date, ruleId] = k.split('|')
    const rule = config.presentations.find((r) => r.id === ruleId)
    const today = rule && presentationOn(config, rule, date)
    if (!today) continue
    const want = new Map<string, number>()
    for (const src of today.sources) {
      const ward = sourceJob(config, src)
      if (ward) want.set(ward, (want.get(ward) ?? 0) + src.count)
    }
    const who = roster.presenters.filter((p) => p.date === date && p.ruleId === ruleId)
    for (const [ward, n] of want) {
      const have = who.filter((p) => coversJob(config.members.find((m) => m.id === p.memberId)!, ward, date) && jobsOn(config.members.find((m) => m.id === p.memberId)!, date).length > 0).length
      if (have < n) {
        redo.add(k)
        wardRedo.add(k)
      }
    }
  }
  const again = pickPresenters(config, responses, roster.assignments, cur).presenters
  const kept = roster.presenters.filter((p) => !redo.has(`${p.date}|${p.ruleId}`))
  const fresh: PresenterAssignment[] = []
  for (const k of redo) {
    const [date, ruleId] = k.split('|')
    const need = roster.presenters.filter((p) => p.date === date && p.ruleId === ruleId).length
    // Not someone presenting that day, or within two days of it.
    const busy = new Set([...kept, ...fresh].filter((p) => Math.abs(dayDiff(p.date, date)) <= 2).map((p) => p.memberId))
    // The new pick for it, minus anyone already presenting that day; the old ones who still fit fill any gap.
    const picks = again.filter((p) => p.date === date && p.ruleId === ruleId && !busy.has(p.memberId))
    // Where the wards' shares were off, only keep those who were really on the shift it draws from.
    const onSource = (p: PresenterAssignment) => {
      const today = presentationOn(config, config.presentations.find((r) => r.id === p.ruleId)!, p.date)
      return Boolean(today?.sources.some((src) => sourceOffsets(src, today.daysBack).some((n) => cur.some((x) => x.memberId === p.memberId && x.date === addDays(p.date, -n) && sourceMatches(config, src, x.shiftId, x.requirementId)))))
    }
    const old = roster.presenters.filter(
      (p) =>
        p.date === date &&
        p.ruleId === ruleId &&
        stillFits(p) &&
        !busy.has(p.memberId) &&
        (!wardRedo.has(k) || onSource(p)),
    )
    const sameDay = new Set([...kept, ...fresh].filter((p) => p.date === date).map((p) => p.memberId))
    // Short of people? Relax "not the day before or after" before leaving a place empty (never twice in a day).
    const relaxed = again.filter((p) => p.date === date && p.ruleId === ruleId && !sameDay.has(p.memberId))
    const oldRelaxed = roster.presenters.filter((p) => p.date === date && p.ruleId === ruleId && !sameDay.has(p.memberId) && (!wardRedo.has(k) || onSource(p)))
    // Last of all: anyone from the right ward who was on duty the night before (never twice in a day).
    const rule = config.presentations.find((r) => r.id === ruleId)!
    const today = presentationOn(config, rule, date)
    const wardFill: PresenterAssignment[] = []
    if (today) {
      for (const src of today.sources) {
        const ward = sourceJob(config, src)
        if (!ward) continue
        for (const x of cur.filter((x) => x.date === addDays(date, -1) && !sameDay.has(x.memberId))) {
          const job = config.shifts.find((sh) => sh.id === x.shiftId)?.requirements.find((r) => r.id === x.requirementId)?.jobId
          if (job === ward) wardFill.push({ date, ruleId, memberId: x.memberId, postCall: true })
        }
      }
    }
    // Keep each ward's share: take, in order of preference, but never more from a ward than it should give.
    const shareOf = new Map<string, number>()
    for (const src of today?.sources ?? []) {
      const ward = sourceJob(config, src)
      if (ward) shareOf.set(ward, (shareOf.get(ward) ?? 0) + src.count)
    }
    const wardNow = (id: string) => [...shareOf.keys()].find((w) => jobsOn(config.members.find((m) => m.id === id)!, date).includes(w))
    const taken: PresenterAssignment[] = []
    for (const p of [...old, ...picks, ...relaxed, ...oldRelaxed, ...wardFill]) {
      if (taken.length >= need || taken.some((q) => q.memberId === p.memberId)) continue
      const w = wardNow(p.memberId)
      if (w && taken.filter((q) => wardNow(q.memberId) === w).length >= (shareOf.get(w) ?? need)) continue
      taken.push(p)
    }
    // Still short (e.g. everyone who'd fit already presents that day): keep the original presenters rather than
    // leave a place empty.
    for (const p of roster.presenters.filter((p) => p.date === date && p.ruleId === ruleId && !sameDay.has(p.memberId))) {
      if (taken.length >= need) break
      if (!taken.some((q) => q.memberId === p.memberId)) taken.push(p)
    }
    fresh.push(...taken)
  }
  const presenters = [...kept, ...fresh].map((p) => ({ ...p })).sort((x, y) => x.date.localeCompare(y.date))
  const presenterDays = [...new Set([...redo].map((k) => k.split('|')[0]))]

  // Re-picking can leave someone without a weekly presentation they had: hand them one of the re-picked turns
  // they could take (they were on its shift), from someone who has more than one.
  for (const rule of config.presentations.filter((r) => !isOneDay(r))) {
    for (const m of studs) {
      const has = (id: string) => presenters.filter((p) => p.ruleId === rule.id && p.memberId === id).length
      if (has(m.id) > 0) continue
      const can = (p: PresenterAssignment) => {
        if (p.ruleId !== rule.id || has(p.memberId) < 2) return false
        if (presenters.some((q) => q.date === p.date && q.memberId === m.id)) return false
        const today = presentationOn(config, rule, p.date)
        return Boolean(today?.sources.some((src) => cur.some((x) => x.memberId === m.id && x.date === addDays(p.date, -1) && sourceMatches(config, src, x.shiftId, x.requirementId))))
      }
      // A day already being re-picked first; any other day only if need be.
      const turn = presenters.find((p) => presenterDays.includes(p.date) && can(p)) ?? presenters.find(can)
      if (turn) {
        turn.memberId = m.id
        if (!presenterDays.includes(turn.date)) presenterDays.push(turn.date)
      }
    }
  }
  const changedPresenterDays = presenterDays.filter((d) => {
    const before = roster.presenters.filter((p) => p.date === d).map((p) => `${p.ruleId}|${p.memberId}`).sort().join()
    const after = presenters.filter((p) => p.date === d).map((p) => `${p.ruleId}|${p.memberId}`).sort().join()
    return before !== after
  })
  return { students: cur, presenters, swaps, presenterDays: changedPresenterDays }
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
    const r = studentResponse(config, responses, memberId)
    if (r.unavailable.includes(to.date) || !canDo(m, to)) return false
    // Leaving a locked shift breaks the lock.
    if (r.locks.some((l) => l.date === leaving.date && l.shiftId === leaving.shiftId) && !(to.date === leaving.date && to.shiftId === leaving.shiftId)) return false
    const others = students.filter((s) => s.memberId === memberId && s !== leaving && s !== also)
    const at = (s: StudentAssignment) => occs.find((x) => x.date === s.date && x.shiftId === s.shiftId && (x.requirementId ?? '') === (s.requirementId ?? ''))
    return others.every((s) => {
      const o = at(s)
      return Math.abs(dayDiff(s.date, to.date)) >= r.minInterval && !(o && overlaps(o, to))
    })
  }
  const fromOcc = occs.find((o) => o.date === from.date && o.shiftId === from.shiftId && (o.requirementId ?? '') === (from.requirementId ?? ''))
  const quota = slotQuota(config)
  const moves = new Set<string>()
  const swaps = new Set<string>()
  for (const o of occs) {
    if (placeKey(o) === placeKey(from)) continue
    if (quota && o.shiftId !== from.shiftId) continue
    const here = students.filter((s) => s.date === o.date && s.shiftId === o.shiftId && (s.requirementId ?? '') === (o.requirementId ?? ''))
    const sourceCount = fromOcc ? students.filter((s) => s.date === fromOcc.date && s.shiftId === fromOcc.shiftId && (s.requirementId ?? '') === (fromOcc.requirementId ?? '')).length : 0
    const sourceOk = !fromOcc || sourceCount - 1 >= fromOcc.min
    if (here.length < o.cap && sourceOk && ok(from.memberId, o, from)) moves.add(placeKey(o))
    if (!fromOcc) continue
    for (const b of here) {
      if (b.memberId === from.memberId) continue
      if (ok(from.memberId, o, from, b) && ok(b.memberId, fromOcc, b, from)) swaps.add(`${placeKey(o)}|${b.memberId}`)
    }
  }
  return { moves, swaps }
}

/** Plain-language check of the soft rules for a student roster, so the host is told what couldn't be met. */
export function studentRuleReport(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  roster: { assignments: Assignment[]; students: StudentAssignment[]; presenters?: PresenterAssignment[] },
) {
  const st = config.students
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  const type = (id: string) => config.members.find((m) => m.id === id)?.type
  const avoidHits = [0, 0, 0, 0]
  const avoidAsked = [0, 0, 0, 0]
  const notes: string[] = []
  const repeats: string[] = []
  const pairs = new Map<string, number>()
  /** Per student, the days they asked to avoid but are on. */
  const unmet: { memberId: string; days: { date: string; level: number }[] }[] = []
  /** Resident/staff repeats, as sentences. */
  const meets: string[] = []
  let alone = 0
  for (const m of config.members.filter((x) => x.type === 'student')) {
    const r = studentResponse(config, responses, m.id)
    const mine = roster.students.filter((s) => s.memberId === m.id)
    const missed: { date: string; level: number }[] = []
    for (const a of r.avoid ?? []) {
      avoidAsked[a.level]++
      if (mine.some((s) => s.date === a.date)) {
        avoidHits[a.level]++
        missed.push({ date: a.date, level: a.level })
        notes.push(t('{name} is on {date}, which they asked to avoid ({level}).', { name: m.name, date: a.date, level: '!'.repeat(a.level) }))
      }
    }
    if (missed.length) unmet.push({ memberId: m.id, days: missed.sort((x, y) => y.level - x.level || x.date.localeCompare(y.date)) })
    const met = new Map<string, number>()
    let withSomeone = false
    for (const s of mine) {
      for (const w of new Set(roster.assignments.filter((a) => a.date === s.date && a.shiftId === s.shiftId).map((a) => a.memberId))) met.set(w, (met.get(w) ?? 0) + 1)
      const mates = roster.students.filter((x) => x.date === s.date && x.shiftId === s.shiftId && x.memberId !== m.id)
      if (mates.length) withSomeone = true
      for (const x of mates) {
        const key = [m.id, x.memberId].sort().join('|')
        pairs.set(key, (pairs.get(key) ?? 0) + 1)
      }
    }
    for (const [w, n] of met) {
      if (n < 2) continue
      if (type(w) === 'resident' && st.avoidRepeatResident) repeats.push(t('{name} meets resident {other} {n} times.', { name: m.name, other: name(w), n }))
      if (type(w) === 'staff' && st.avoidRepeatStaff) repeats.push(t('{name} meets {other} {n} times.', { name: m.name, other: name(w), n }))
      if ((type(w) === 'resident' && st.avoidRepeatResident) || (type(w) === 'staff' && st.avoidRepeatStaff)) meets.push(repeats[repeats.length - 1])
    }
    if (mine.length > 1 && !withSomeone) alone++
  }
  const pairRepeats: { a: string; b: string; n: number }[] = []
  if (st.avoidRepeatPartner) {
    for (const [key, n] of pairs) {
      // Each shared shift is counted from both sides.
      if (n / 2 >= 2) {
        const [a, b] = key.split('|')
        pairRepeats.push({ a, b, n: n / 2 })
        repeats.push(t('{a} and {b} share {n} shifts.', { a: name(a), b: name(b), n: n / 2 }))
      }
    }
    pairRepeats.sort((x, y) => y.n - x.n)
  }
  const summary: string[] = []
  /** Within the host's limit on how far apart points may be (true when there's no limit). */
  let pointsOk = true
  /** Most minus fewest points (shifts, plus presentations when they count); 0 when points are off. */
  let pointsSpread = 0
  /** Students who never present at some weekly presentation (everyone should, at least once). */
  const missingWeekly: string[] = []
  if (st.auto) {
    const counts = config.members.filter((m) => m.type === 'student').map((m) => roster.students.filter((s) => s.memberId === m.id).length)
    if (counts.length) {
      const [a, b] = [Math.min(...counts), Math.max(...counts)]
      summary.push(`⚖️ ${a === b ? t('{a} shifts each', { a }) : t('{a}–{b} shifts each', { a, b })}`)
    }
  }
  if (st.points?.on) {
    // With presentations counting towards points, each person's presentation points are added.
    const fromTalks = presentationsCount(config) && roster.presenters ? presentationLoad(config, roster.presenters) : {}
    const pts = config.members
      .filter((m) => m.type === 'student')
      .map((m) => roster.students.filter((s) => s.memberId === m.id).reduce((n, s) => n + shiftPoints(config, s.shiftId, s.date), fromTalks[m.id] ?? 0))
    if (pts.length) {
      const [a, b] = [Math.min(...pts), Math.max(...pts)]
      pointsSpread = b - a
      const limit = st.points.maxDiff
      const avg = pts.reduce((x, y) => x + y, 0) / pts.length
      const pct = avg ? Math.round(((b - a) / avg) * 100) : 0
      const range = a === b ? t('{a} points each', { a: fmtPoints(a) }) : t('{a}–{b} points each', { a: fmtPoints(a), b: fmtPoints(b) })
      summary.push(
        limit
          ? pointsOver(pts, limit) > 0
            ? `⚠️ ${range} — ${t('{p}% apart, above your {limit}% limit', { p: pct, limit })}`
            : `✅ ${range} — ${t('{p}% apart, within {limit}%', { p: pct, limit })}`
          : `🎯 ${range}`,
      )
      if (limit && pointsOver(pts, limit) > 0) pointsOk = false
      if (limit && pointsOver(pts, limit) > 0) notes.push(t('Points are {p}% apart ({a}–{b}); your limit is {limit}%.', { p: pct, a: fmtPoints(a), b: fmtPoints(b), limit }))
    }
  }
  if (config.presentations.length && roster.presenters?.length) {
    // Presentations each, in all and (when there are several types) by type.
    const studs = config.members.filter((m) => m.type === 'student')
    const range = (f: (p: PresenterAssignment) => boolean) => {
      const n = studs.map((m) => roster.presenters!.filter((p) => p.memberId === m.id && f(p)).length)
      const [a, b] = [Math.min(...n), Math.max(...n)]
      return a === b ? String(a) : `${a}–${b}`
    }
    const oneDay = new Set(config.presentations.filter(isOneDay).map((r) => r.id))
    const kinds = [
      ...config.presentations.filter((r) => !isOneDay(r)).map((r) => ({ name: r.name, f: (p: PresenterAssignment) => p.ruleId === r.id })),
      ...(oneDay.size ? [{ name: t('one-day'), f: (p: PresenterAssignment) => oneDay.has(p.ruleId) }] : []),
    ]
    summary.push(
      `🎤 ${t('{n} presentations each', { n: range(() => true) })}${kinds.length > 1 ? ` (${kinds.map((k) => `${k.name} ${range(k.f)}`).join(', ')})` : ''}`,
    )
    // Everyone should present at each weekly presentation at least once.
    for (const r of config.presentations.filter((x) => !isOneDay(x))) {
      const none = studs.filter((m) => !roster.presenters!.some((x) => x.memberId === m.id && x.ruleId === r.id))
      if (none.length) {
        summary.push(`⚠️ ${t('{n} never present at {rule}', { n: none.length, rule: r.name })}`)
        notes.push(t('Never present at {rule}: {names}.', { rule: r.name, names: none.map((m) => m.name).join(', ') }))
        for (const m of none) if (!missingWeekly.includes(m.id)) missingWeekly.push(m.id)
      }
    }
    // Nobody should present twice in a day.
    const p = roster.presenters
    const twice = p.filter((x, i) => p.findIndex((y) => y.date === x.date && y.memberId === x.memberId) !== i)
    if (twice.length) summary.push(`⚠️ ${t('{n} time(s) someone presents twice in a day', { n: twice.length })}`)
    for (const x of twice) notes.push(t('{name} presents twice on {date}.', { name: name(x.memberId), date: x.date }))
  }
  const asked = avoidAsked[1] + avoidAsked[2] + avoidAsked[3]
  if (asked) {
    const hits = avoidHits[1] + avoidHits[2] + avoidHits[3]
    summary.push(
      hits
        ? t('{hits} of {asked} avoid requests not met (!!! {a}, !! {b}, ! {c})', { hits, asked, a: avoidHits[3], b: avoidHits[2], c: avoidHits[1] })
        : `✅ ${t('all {n} avoid requests met', { n: asked })}`,
    )
  }
  const checked = [st.avoidRepeatResident && 'residents', st.avoidRepeatStaff && 'staff', st.avoidRepeatPartner && 'student pairs'].filter(Boolean)
  if (checked.length && !repeats.length) summary.push(`✅ ${t('no repeats ({what})', { what: checked.map((c) => t(c as string)).join(', ') })}`)
  if (pairRepeats.length) summary.push(`👥 ${t('{n} pair(s) of students together more than once', { n: pairRepeats.length })}`)
  if (meets.length) summary.push(`🔁 ${t('{n} time(s) a student meets the same resident or staff again', { n: meets.length })}`)
  if (st.wantPartner) summary.push(alone ? `⚠️ ${t('{n} student(s) alone on every shift', { n: alone })}` : `✅ ${t('everyone has a partner at least once')}`)
  return { summary, details: [...notes, ...repeats], avoidHits, repeats: repeats.length, alone, unmet, pairRepeats, meets, pointsOk, pointsSpread, missingWeekly }
}

/** Each student's shifts (with who they're with), points and presentations: the Per student view and its export. */
export function studentDetails(config: SessionConfig, roster: { assignments: Assignment[]; students: StudentAssignment[]; presenters?: PresenterAssignment[] }) {
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  const type = (id: string) => config.members.find((m) => m.id === id)?.type
  const fromTalks = presentationsCount(config) && roster.presenters ? presentationLoad(config, roster.presenters) : {}
  const oneDay = new Set(config.presentations.filter(isOneDay).map((r) => r.id))
  // The student place (and its ward) someone is in.
  const jobOf = (x: StudentAssignment) => config.shifts.find((sh) => sh.id === x.shiftId)?.requirements.find((r) => r.id === x.requirementId)?.jobId ?? ''
  const jobName = (id: string) => config.jobs.find((j) => j.id === id)?.name ?? ''
  const shiftName = (id: string) => config.shifts.find((sh) => sh.id === id)?.name ?? ''
  return config.members
    .filter((m) => m.type === 'student')
    .map((m) => {
      const mine = roster.students.filter((s) => s.memberId === m.id).sort((a, b) => a.date.localeCompare(b.date))
      const gives = (roster.presenters ?? []).filter((p) => p.memberId === m.id).sort((a, b) => a.date.localeCompare(b.date))
      const shifts = mine.map((s) => {
        const shift = config.shifts.find((x) => x.id === s.shiftId)
        const ward = jobOf(s)
        const on = roster.assignments.filter((a) => a.date === s.date && a.shiftId === s.shiftId).map((a) => a.memberId)
        // Who they're with: the same ward that day first — on another shift marked "→ shift" — then the same
        // shift in another ward, marked "· ward".
        const others = roster.students.filter((x) => x.date === s.date && x.memberId !== m.id)
        const sameWard = sortedBy(
          others.filter((x) => jobOf(x) === ward),
          (x) => (x.shiftId === s.shiftId ? 0 : 1),
        )
        const elsewhere = others.filter((x) => jobOf(x) !== ward && x.shiftId === s.shiftId)
        return {
          date: s.date,
          shift: shift?.name ?? '',
          ward: ward && config.jobs.length > 1 ? jobName(ward) : '',
          times: shift ? shiftTimes(shift) : '',
          with: [
            ...sameWard.map((x) => (x.shiftId === s.shiftId ? name(x.memberId) : `${name(x.memberId)} → ${shiftName(x.shiftId)}`)),
            ...elsewhere.map((x) => `${name(x.memberId)} · ${jobName(jobOf(x)) || shiftName(x.shiftId)}`),
          ],
          residents: on.filter((w) => type(w) === 'resident').map(name),
          staff: on.filter((w) => type(w) === 'staff').map(name),
        }
      })
      // Days between one shift and the next: on average, the shortest, and per type of shift (slot).
      const gaps = (xs: StudentAssignment[]) => xs.slice(1).map((x, i) => dayDiff(xs[i].date, x.date))
      const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
      const all = gaps(mine)
      const bySlot = config.shifts
        .map((sh) => {
          const g = gaps(mine.filter((x) => x.shiftId === sh.id))
          return { shift: sh.name, count: mine.filter((x) => x.shiftId === sh.id).length, avg: avg(g), shortest: g.length ? Math.min(...g) : null }
        })
        .filter((x) => x.count > 0)
      return {
        member: m,
        shifts,
        gap: { avg: avg(all), shortest: all.length ? Math.min(...all) : null, bySlot },
        points: mine.reduce((n, s) => n + shiftPoints(config, s.shiftId, s.date), fromTalks[m.id] ?? 0),
        presents: gives.map((p) => ({ ...p, name: config.presentations.find((r) => r.id === p.ruleId)?.name ?? '' })),
        byRule: (ruleId: string) => gives.filter((p) => p.ruleId === ruleId).length,
        oneDay: gives.filter((p) => oneDay.has(p.ruleId)).length,
      }
    })
}

/**
 * The Per student view as a spreadsheet: one row per student with shifts, points, presentations (in all and by
 * type), then each shift's date, weekday, slot, who they're with, and residents and staff when there are any.
 * `lead` = columns before the first shift's date; `per` = columns per shift.
 */
export function studentSummaryTable(config: SessionConfig, roster: { assignments: Assignment[]; students: StudentAssignment[]; presenters?: PresenterAssignment[] }) {
  const details = studentDetails(config, roster)
  const most = Math.max(0, ...details.map((d) => d.shifts.length))
  const pointsOn = Boolean(config.students.points?.on)
  // Presentations: each weekly one is a type, one-day ones count together.
  const weekly = config.presentations.filter((r) => !isOneDay(r))
  const anyOneDay = config.presentations.some(isOneDay)
  const presents = config.presentations.length > 0 && roster.presenters !== undefined
  const slotsUsed = config.shifts.filter((sh) => details.some((d) => d.gap.bySlot.some((x) => x.shift === sh.name)))
  const header = [
    t('Student'),
    t('Shifts'),
    t('Average days between shifts'),
    ...slotsUsed.map((sh) => t('Average days between {shift}', { shift: sh.name })),
    ...(pointsOn ? [presentationsCount(config) ? t('Points (shifts + presentations)') : t('Points')] : []),
    ...(presents ? [t('Presentations'), ...(weekly.length > 1 || anyOneDay ? weekly.map((r) => r.name) : []), ...(anyOneDay ? [t('One-day presentations')] : [])] : []),
  ]
  const lead = header.length
  // Residents and staff only when the roster has any.
  const doctors = roster.assignments.length > 0
  const per = doctors ? 6 : 4
  for (let i = 1; i <= most; i++) header.push(t('Shift {i} date', { i }), t('Day'), t('Shift'), t('With'), ...(doctors ? [t('Resident'), t('Staff')] : []))
  const rows = details.map((d) => {
    const days = (n: number | null | undefined) => (n == null ? '-' : fmtPoints(Math.round(n * 10) / 10))
    const row = [
      d.member.name,
      String(d.shifts.length),
      days(d.gap.avg),
      ...slotsUsed.map((sh) => days(d.gap.bySlot.find((x) => x.shift === sh.name)?.avg)),
      ...(pointsOn ? [fmtPoints(d.points)] : []),
      ...(presents
        ? [String(d.presents.length), ...(weekly.length > 1 || anyOneDay ? weekly.map((r) => String(d.byRule(r.id))) : []), ...(anyOneDay ? [String(d.oneDay)] : [])]
        : []),
    ]
    for (let i = 0; i < most; i++) {
      const s = d.shifts[i]
      if (!s) {
        row.push(...Array(per).fill(''))
        continue
      }
      row.push(
        s.date,
        weekdayShort()[weekday(s.date)],
        `${s.shift}${s.ward ? ` · ${s.ward}` : ''} (${s.times})`,
        s.with.join(', ') || '-',
        ...(doctors ? [s.residents.join(', ') || '-', s.staff.join(', ') || '-'] : []),
      )
    }
    return row
  })
  return { header, rows, lead, per }
}

/** Presentations given one day (`gap` 1: two days in a row) or two days (`gap` 2: every other day) after the same person's previous one. */
export function presentsInARow(presenters: PresenterAssignment[], gap: 1 | 2 = 1) {
  const out: { memberId: string; date: string }[] = []
  const days = new Map<string, Set<string>>()
  for (const p of presenters) days.set(p.memberId, (days.get(p.memberId) ?? new Set()).add(p.date))
  for (const [memberId, ds] of days) for (const d of ds) if (ds.has(addDays(d, -gap))) out.push({ memberId, date: d })
  return out
}

/** One line of the fairness table: a rule, the setting it follows, what the roster gives, and whether that's met. */
export interface FairnessRow {
  key: string
  what: string
  setting: string
  result: string
  /** true met, false not met, null nothing to meet (just a measure). */
  ok: boolean | null
}

/**
 * Whether someone's shift days (days from the start, sorted) fit the pattern they asked for, over an n-day period.
 * Spread out: no gap longer than twice the even spacing. Grouped: at least half their shifts sit next to another
 * at their shortest allowed gap.
 */
export function fitsPattern(days: number[], n: number, r: MemberResponse): boolean {
  if (days.length < 2) return true
  const gaps = days.slice(1).map((d, i) => d - days[i])
  if (r.preference === 'distributed') return Math.max(...gaps) <= (2 * n) / days.length
  const paired = days.filter((_, i) => gaps[i - 1] === r.minInterval || gaps[i] === r.minInterval).length
  return paired * 2 >= days.length
}

/** Every fairness rule Wayneday accounts for, with this roster's result: for the fairness table and comparing two. */
export function fairnessReport(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  roster: { assignments: Assignment[]; students: StudentAssignment[]; presenters: PresenterAssignment[] },
): FairnessRow[] {
  const st = config.students
  const studs = config.members.filter((m) => m.type === 'student')
  const groups = shareGroups(config)
  const report = studentRuleReport(config, responses, roster)
  const details = studentDetails(config, roster)
  const range = (xs: number[]) => {
    if (!xs.length) return '-'
    const [a, b] = [Math.min(...xs), Math.max(...xs)]
    return a === b ? fmtPoints(a) : `${fmtPoints(a)}–${fmtPoints(b)}`
  }
  const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0)
  // By group when students rotate in groups ("7–8 / 8–9"), else for everyone.
  const byGroup = (f: (si: number) => number) => groups.map((g) => g.members.map(f))
  const groupRanges = (f: (si: number) => number) => byGroup(f).map(range).join(' / ')
  const count = (si: number, filter: (x: StudentAssignment) => boolean = () => true) => roster.students.filter((x) => x.memberId === studs[si].id && filter(x)).length
  const rows: FairnessRow[] = []

  const need = shiftsNeeded(config)
  rows.push({
    key: 'shifts',
    what: t('Shifts each'),
    setting: st.auto ? (groups.length > 1 ? t('Equal share, ±1 within each group') : t('Equal share, ±1')) : t('{n} each', { n: need }),
    result: groupRanges((si) => count(si)),
    ok: st.auto ? byGroup((si) => count(si)).every((xs) => spread(xs) <= 1) : studs.every((_, si) => count(si) === need),
  })
  const load = loadPoints(config, roster.students, roster.presenters)
  for (const sh of config.shifts.filter((x) => roster.students.some((y) => y.shiftId === x.id))) {
    const alwaysEven = Boolean(st.evenSlots?.includes(sh.id))
    const uneven = groups.reduce(
      (n, g) => n + unevenType(g.members.map((si) => count(si, (x) => x.shiftId === sh.id)), load ? g.members.map((si) => load[studs[si].id] ?? 0) : null),
      0,
    )
    const strict = byGroup((si) => count(si, (x) => x.shiftId === sh.id)).every((xs) => spread(xs) <= 1)
    rows.push({
      key: `type-${sh.id}`,
      what: sh.name,
      setting: alwaysEven
        ? load
          ? t('At most 1 apart; if not possible, made up for in points')
          : t('Even, at most 1 apart')
        : load
          ? t('At most 1 apart, unless made up for in points')
          : t('Even, at most 1 apart'),
      result: `${groupRanges((si) => count(si, (x) => x.shiftId === sh.id))}${!strict && uneven === 0 ? ` (${t('made up for')})` : ''}`,
      ok: uneven === 0,
    })
  }
  if (st.points?.on) {
    const pts = details.map((d) => d.points)
    const avg = pts.reduce((a, b) => a + b, 0) / (pts.length || 1)
    const pct = avg ? Math.round((spread(pts) / avg) * 100) : 0
    rows.push({
      key: 'points',
      what: presentationsCount(config) ? t('Points (shifts + presentations)') : t('Points'),
      setting: st.points.maxDiff ? t('Within {p}% of the average', { p: st.points.maxDiff }) : t('As equal as possible'),
      result: `${range(pts)} (${t('{p}% apart', { p: pct })})`,
      ok: st.points.maxDiff ? report.pointsOk : null,
    })
  }
  if (config.presentations.length) {
    const talk = presentationLoad(config, roster.presenters)
    rows.push({
      key: 'talks',
      what: t('Presentations'),
      setting: t('Even by their points'),
      result: `${range(details.map((d) => d.presents.length))} (${range(studs.map((m) => talk[m.id] ?? 0))} ${t('pts')})`,
      ok: null,
    })
    for (const r of config.presentations.filter((x) => !isOneDay(x))) {
      const n = details.map((d) => d.byRule(r.id))
      rows.push({ key: `talk-${r.id}`, what: r.name, setting: t('Everyone at least once'), result: range(n), ok: n.every((k) => k > 0) })
    }
    if (config.presentations.some(isOneDay)) {
      rows.push({ key: 'talk-one-day', what: t('One-day presentations'), setting: t('Even, as the nights allow'), result: range(details.map((d) => d.oneDay)), ok: null })
    }
    const p = roster.presenters
    const twice = p.filter((x, i) => p.findIndex((y) => y.date === x.date && y.memberId === x.memberId) !== i).length
    rows.push({ key: 'twice', what: t('Twice in a day'), setting: t('Nobody presents twice in a day'), result: String(twice), ok: twice === 0 })
    const inARow = presentsInARow(p)
    rows.push({ key: 'row', what: t('Two days in a row'), setting: t('Nobody presents two days running'), result: String(inARow.length), ok: inARow.length === 0 })
    const alternate = presentsInARow(p, 2)
    rows.push({ key: 'row2', what: t('Presenting every other day'), setting: t('Not two days apart, if possible'), result: String(alternate.length), ok: alternate.length === 0 ? true : null })

  }
  const asked = studs.reduce((n, m) => n + (studentResponse(config, responses, m.id).avoid?.length ?? 0), 0)
  rows.push({
    key: 'avoid',
    what: t('Days asked to avoid'),
    setting: t('!!! first, then !!, then !'),
    result: t('{a} !!! · {b} !! · {c} ! not met (of {n})', { a: report.avoidHits[3], b: report.avoidHits[2], c: report.avoidHits[1], n: asked }),
    ok: report.avoidHits[3] === 0 ? (report.avoidHits[2] + report.avoidHits[1] === 0 ? true : null) : false,
  })
  const hard = [...studentCellIssues(config, responses, roster.students).values()].flat().length
  rows.push({ key: 'hard', what: t('Hard rules'), setting: t('✕ days, minimum gaps, places, locks'), result: hard ? t('{n} broken', { n: hard }) : t('all kept'), ok: hard === 0 })
  if (st.avoidRepeatPartner) {
    rows.push({ key: 'pairs', what: t('Same two students together'), setting: t('Not twice'), result: t('{n} pair(s) more than once', { n: report.pairRepeats.length }), ok: report.pairRepeats.length === 0 ? true : null })
  }
  const runs = details.reduce((n, d) => n + everyOtherDay(d.shifts.map((x) => dayDiff(config.startDate, x.date))), 0)
  rows.push({ key: 'alt', what: t('On duty every other day'), setting: t('Not three times running (e.g. Mon–Wed–Fri)'), result: String(runs), ok: runs === 0 ? true : null })
  // Each student's own answer, spread out or grouped (only those who answered).
  const period = dayDiff(config.startDate, config.endDate) + 1
  for (const pref of ['distributed', 'dense'] as const) {
    const who = studs.filter((m) => responses[m.id]?.preference === pref)
    if (!who.length) continue
    const misses = who.filter((m) => {
      const days = [...new Set(roster.students.filter((x) => x.memberId === m.id).map((x) => dayDiff(config.startDate, x.date)))].sort((a, b) => a - b)
      return !fitsPattern(days, period, studentResponse(config, responses, m.id))
    })
    const names = misses.map((m) => m.name)
    rows.push({
      key: `pattern-${pref}`,
      what: pref === 'distributed' ? t('Asked for spread out') : t('Asked for grouped'),
      setting: pref === 'distributed' ? t('No gap longer than twice the even spacing') : t('At least half their shifts next to another, at their shortest gap'),
      result: `${t('{n} of {total}', { n: who.length - misses.length, total: who.length })}${names.length ? ` (${t('not: {names}', { names: names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ') })})` : ''}`,
      ok: misses.length === 0 ? true : null,
    })
  }
  const gaps = details.map((d) => d.gap.avg).filter((x): x is number => x != null)
  rows.push({
    key: 'gaps',
    what: t('Days between shifts'),
    setting: (st.minGap ?? 0) > 0 ? t('At least {n}', { n: st.minGap! }) : t('Each student’s own answer'),
    result: `${t('{r} on average', { r: range(gaps.map((g) => Math.round(g * 10) / 10)) })}, ${t('shortest {n}', { n: Math.min(...details.map((d) => d.gap.shortest ?? 99)) })}`,
    ok: null,
  })
  return rows
}
