// Second phase, after residents and staff are fixed:
// - place students onto the shift slots they join, so every resident/staff is on duty with students
//   about equally often (balanced within each type), respecting each student's availability,
//   locks, minimum interval and spread/grouped preference;
// - pick presenters for presentation rules, taking the required number from yesterday's shift first.

import { fmtPoints, presentationOn, reqCount, reqMin, shiftPoints, shiftRuns } from './calendar.ts'
import { t, weekdayShort } from './i18n.ts'
import { addDays, dateRange, dayDiff, weekday } from './dates.ts'
import { preferenceCost, responseFor, rng, variance } from './scoring.ts'
import { ANY_SHIFT, fromRuleShift, presenterTypes, type Assignment, type Member, type MemberResponse, type PresenterAssignment, type SessionConfig, type StudentAssignment } from './types.ts'

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
      if (config.rosterMode === 'hospital') {
        for (const req of shift.requirements) {
          const cap = reqCount(config, shift, req, date)
          const min = reqMin(config, shift, req, date)
          if (cap > 0) occs.push({ i: occs.length, day, date, shiftId: shift.id, requirementId: req.id, jobId: req.jobId, cap, min, weekend, pts, workers })
        }
      } else if (config.students.shiftIds.includes(shift.id)) {
        occs.push({ i: occs.length, day, date, shiftId: shift.id, cap: Math.max(1, config.students.maxPerShift), min: 0, weekend, pts, workers })
      }
    }
  })
  return occs
}

const canDo = (m: Member, o: Occ) => !o.jobId || m.jobs.length === 0 || m.jobs.includes(o.jobId)

/** Penalty for working a date someone asked to avoid, by level (mirrors "try 20% / 40% / 60%"). */
export const AVOID_PENALTY = [0, 100, 200, 300]
const REPEAT_RESIDENT_PENALTY = 400

const REPEAT_STAFF_PENALTY = 300
const REPEAT_PARTNER_PENALTY = 350
const ALONE_PENALTY = 150

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

/** Most shifts each student can fit in their allowed places, keeping their gap (earliest-first is optimal). */
function fitCounts(occs: Occ[], allowed: number[][], gaps: number[]): number[] {
  return allowed.map((list, si) => {
    let n = 0
    let last = -Infinity
    for (const oi of list) {
      if (occs[oi].day - last >= gaps[si]) {
        n++
        last = occs[oi].day
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
  const total = students.length ? Math.min(places, equalMost(fit)) : places
  const fewest = Math.min(...fit)
  return { places, ...equalShare(config, total), limited: total < places ? { name: students[fit.indexOf(fewest)].name, k: fewest } : null }
}

/** Shifts each student does in total (the most anyone does, when sharing equally). */
export function shiftsNeeded(config: SessionConfig): number {
  if (config.students.auto) {
    const { base, extra } = equalShare(config)
    return base + (extra ? 1 : 0)
  }
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

  const rand = rng(seed * 7919 + 13)
  // Shifts each student does. Sharing equally, the students with the most open places take the extra
  // ones (with a random tie-break, so each option shares them differently).
  let needs = students.map(() => need)
  const shareOut = (total: number) => {
    const { base, extra } = equalShare(config, total)
    const order = students.map((_, si) => si).sort((a, b) => allowed[b].length - allowed[a].length + (rand() - 0.5) * 6)
    needs = students.map(() => base)
    for (const si of order.slice(0, extra)) needs[si]++
  }
  // mine[si] = occurrence indexes; load[oi] = students on that occurrence
  let mine: number[][] = []
  let load: number[] = []
  let fixed: Set<string> = new Set()
  const spaced = (si: number, oi: number, ignore = -1) =>
    !mine[si].includes(oi) && mine[si].every((x) => x === ignore || Math.abs(occs[x].day - occs[oi].day) >= resp[si].minInterval)
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
  const most = equalMost(fitMax)
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
          if (cands.length) add(cands.sort((a, b) => needs[b] - mine[b].length - (needs[a] - mine[a].length) + (rand() - 0.5) * 0.9)[0], o.i)
          else if (load[o.i] < o.min) placed = false
          else break
        }
      }
      for (let round = 0; round < Math.max(...needs) && placed; round++) {
        const order = students.map((_, si) => si).sort(() => rand() - 0.5)
        for (const si of order) {
          if (mine[si].length > round || mine[si].length >= needs[si]) continue
          const cands = allowed[si].filter((oi) => fits(si, oi))
          if (cands.length === 0) {
            placed = false
            break
          }
          // Prefer places still under their minimum, then emptier ones, then random.
          const key = (oi: number) => (load[oi] < occs[oi].min ? -10 : 0) + load[oi] + (rand() - 0.5) * 0.9
          cands.sort((a, b) => key(a) - key(b))
          add(si, cands[0])
        }
      }
      if (placed && occs.some((o) => load[o.i] < o.min)) placed = false
    }
    if (placed || !auto || total <= minimum || tries >= 3 * students.length) break
    total--
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
    if (pointsOn) sc += 80 * variance(mine.map((m) => m.reduce((n, oi) => n + occs[oi].pts, 0)))
    else sc += 30 * variance(mine.map((m) => m.filter((oi) => occs[oi].weekend).length))
    if (auto) for (const id of slotIds) sc += 40 * variance(mine.map((m) => m.filter((oi) => occs[oi].shiftId === id).length))
    mine.forEach((m, si) => {
      sc += preferenceCost(m.map((oi) => occs[oi].day).sort((a, b) => a - b), days.length, resp[si])
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
      // Trade places with another student (keeps every place's count, so minimums hold).
      const sj = Math.floor(rand() * students.length)
      if (sj === si || mine[sj].length === 0) continue
      const to = mine[sj][Math.floor(rand() * mine[sj].length)]
      if (to === from || fixed.has(`${sj}:${to}`) || !allowed[si].includes(to) || !allowed[sj].includes(from)) continue
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
  const rand = rng(seed * 31 + 7)
  const presenters: PresenterAssignment[] = []
  const warnings: string[] = []
  const count = new Map<string, number>()
  const days = dateRange(config.startDate, config.endDate)
  const available = (id: string, date: string) => !responseFor(responses, id).unavailable.includes(date)
  const byFewest = (ids: string[]) =>
    ids.map((id) => ({ id, k: (count.get(id) ?? 0) + rand() * 0.5 })).sort((a, b) => a.k - b.k).map((x) => x.id)

  for (const rule of config.presentations) {
    const shiftName = rule.fromShiftId === ANY_SHIFT ? t('any shift') : (config.shifts.find((s) => s.id === rule.fromShiftId)?.name ?? 'that shift')
    const short: string[] = []
    for (const date of days) {
      const today = presentationOn(config, rule, date)
      if (!today) continue
      const yesterday = addDays(date, -1)
      const types = presenterTypes(config, rule)
      const eligible = config.members.filter((m) => types.includes(m.type) && available(m.id, date)).map((m) => m.id)
      let post: string[] = []
      if (yesterday >= config.startDate) {
        post = [
          ...assignments.filter((a) => a.date === yesterday && fromRuleShift(rule, a.shiftId)).map((a) => a.memberId),
          ...students.filter((s) => s.date === yesterday && fromRuleShift(rule, s.shiftId)).map((s) => s.memberId),
        ].filter((id, i, arr) => arr.indexOf(id) === i && eligible.includes(id))
      }
      const chosen = byFewest(post).slice(0, today.fromCount)
      if (chosen.length < today.fromCount && yesterday >= config.startDate) short.push(date)
      for (const id of byFewest(eligible.filter((id) => !chosen.includes(id)))) {
        if (chosen.length >= today.count) break
        chosen.push(id)
      }
      if (chosen.length < today.count) warnings.push(t('{date} {rule}: only {n} of {need} presenters available.', { date, rule: rule.name, n: chosen.length, need: today.count }))
      for (const id of chosen) {
        count.set(id, (count.get(id) ?? 0) + 1)
        presenters.push({ date, ruleId: rule.id, memberId: id, postCall: post.includes(id) })
      }
    }
    if (short.length) {
      warnings.push(
        t('{rule}: not enough people from the previous {shift} on {n} day(s) ({dates}). Check which member types the rule allows.', { rule: rule.name, shift: shiftName, n: short.length, dates: `${short.slice(0, 3).join(', ')}${short.length > 3 ? '…' : ''}` }),
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
  opts: { nodeLimit?: number; probes?: number; seed?: number; ms?: number } = {},
): { exact: true; count: number } | { exact: false; log10: number } {
  const students = config.members.filter((m) => m.type === 'student')
  const occs = studentOccs(config, config.duty)
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
    const left = needs[si] - picked.length
    return occs
      .map((_, i) => i)
      .filter((i) => {
        if (i <= last || !free(si, i)) return false
        if (picked.length && occs[i].day - occs[picked[picked.length - 1]].day < resp[si].minInterval) return false
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
      else if (!canDo(m, o)) add(placeKey(s), t('{name} doesn’t cover this job.', { name: m.name }))
    }
    for (let i = 1; i < mine.length; i++) {
      const gap = dayDiff(mine[i - 1].date, mine[i].date)
      if (gap < r.minInterval) {
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
    // Whatever was placed, nobody should have more than one shift more than anyone else.
    const { base, extra } = equalShare(config, students.length)
    for (const m of config.members.filter((x) => x.type === 'student')) {
      const n = students.filter((s) => s.memberId === m.id).length
      const first = students.find((s) => s.memberId === m.id)
      if ((n < base || n > base + (extra ? 1 : 0)) && first) {
        add(placeKey(first), t('{name} has {n} shifts; an equal share is {share}.', { name: m.name, n, share: extra ? `${base}–${base + 1}` : base }))
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
    return others.every((s) => Math.abs(dayDiff(s.date, to.date)) >= r.minInterval)
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
export function studentRuleReport(config: SessionConfig, responses: Record<string, MemberResponse>, roster: { assignments: Assignment[]; students: StudentAssignment[] }) {
  const st = config.students
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  const type = (id: string) => config.members.find((m) => m.id === id)?.type
  const avoidHits = [0, 0, 0, 0]
  const avoidAsked = [0, 0, 0, 0]
  const notes: string[] = []
  const repeats: string[] = []
  const pairs = new Map<string, number>()
  let alone = 0
  for (const m of config.members.filter((x) => x.type === 'student')) {
    const r = studentResponse(config, responses, m.id)
    const mine = roster.students.filter((s) => s.memberId === m.id)
    for (const a of r.avoid ?? []) {
      avoidAsked[a.level]++
      if (mine.some((s) => s.date === a.date)) {
        avoidHits[a.level]++
        notes.push(t('{name} is on {date}, which they asked to avoid ({level}).', { name: m.name, date: a.date, level: '!'.repeat(a.level) }))
      }
    }
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
    }
    if (mine.length > 1 && !withSomeone) alone++
  }
  if (st.avoidRepeatPartner) {
    for (const [key, n] of pairs) {
      // Each shared shift is counted from both sides.
      if (n / 2 >= 2) repeats.push(t('{a} and {b} share {n} shifts.', { a: name(key.split('|')[0]), b: name(key.split('|')[1]), n: n / 2 }))
    }
  }
  const summary: string[] = []
  if (st.auto) {
    const counts = config.members.filter((m) => m.type === 'student').map((m) => roster.students.filter((s) => s.memberId === m.id).length)
    if (counts.length) {
      const [a, b] = [Math.min(...counts), Math.max(...counts)]
      summary.push(`⚖️ ${a === b ? t('{a} shifts each', { a }) : t('{a}–{b} shifts each', { a, b })}`)
    }
  }
  if (st.points?.on) {
    const pts = config.members
      .filter((m) => m.type === 'student')
      .map((m) => roster.students.filter((s) => s.memberId === m.id).reduce((n, s) => n + shiftPoints(config, s.shiftId, s.date), 0))
    if (pts.length) {
      const [a, b] = [Math.min(...pts), Math.max(...pts)]
      summary.push(`🎯 ${a === b ? t('{a} points each', { a: fmtPoints(a) }) : t('{a}–{b} points each', { a: fmtPoints(a), b: fmtPoints(b) })}`)
    }
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
  if (checked.length) summary.push(repeats.length ? `⚠️ ${t('{n} repeat(s)', { n: repeats.length })}` : `✅ ${t('no repeats ({what})', { what: checked.map((c) => t(c as string)).join(', ') })}`)
  if (st.wantPartner) summary.push(alone ? `⚠️ ${t('{n} student(s) alone on every shift', { n: alone })}` : `✅ ${t('everyone has a partner at least once')}`)
  return { summary, details: [...notes, ...repeats], avoidHits, repeats: repeats.length, alone }
}

/** One row per student: each shift's date, weekday, slot, fellow students, residents and staff. */
export function studentSummaryTable(config: SessionConfig, roster: { assignments: Assignment[]; students: StudentAssignment[] }) {
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  const type = (id: string) => config.members.find((m) => m.id === id)?.type
  const students = config.members.filter((m) => m.type === 'student')
  const most = Math.max(0, ...students.map((m) => roster.students.filter((s) => s.memberId === m.id).length))
  const pointsOn = Boolean(config.students.points?.on)
  const header = [t('Student'), t('Shifts'), ...(pointsOn ? [t('Points')] : [])]
  for (let i = 1; i <= most; i++) header.push(t('Shift {i} date', { i }), t('Day'), t('Shift'), t('With'), t('Resident'), t('Staff'))
  const rows = students.map((m) => {
    const mine = roster.students.filter((s) => s.memberId === m.id).sort((a, b) => a.date.localeCompare(b.date))
    const row = [m.name, String(mine.length), ...(pointsOn ? [fmtPoints(mine.reduce((n, s) => n + shiftPoints(config, s.shiftId, s.date), 0))] : [])]
    for (let i = 0; i < most; i++) {
      const s = mine[i]
      if (!s) {
        row.push('', '', '', '', '', '')
        continue
      }
      const shift = config.shifts.find((x) => x.id === s.shiftId)
      const on = roster.assignments.filter((a) => a.date === s.date && a.shiftId === s.shiftId).map((a) => a.memberId)
      const mates = roster.students.filter((x) => x.date === s.date && x.shiftId === s.shiftId && x.memberId !== m.id).map((x) => name(x.memberId))
      row.push(
        s.date,
        weekdayShort()[weekday(s.date)],
        shift ? `${shift.name} (${shift.start}–${shift.end})` : '',
        mates.join(', ') || '-',
        on.filter((w) => type(w) === 'resident').map(name).join(', ') || '-',
        on.filter((w) => type(w) === 'staff').map(name).join(', ') || '-',
      )
    }
    return row
  })
  return { header, rows }
}
