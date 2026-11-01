// Hand-off to an external AI for conditions the built-in solver can't express (e.g. morning rounds).
// The prompt carries the whole roster problem plus the current roster in the exact JSON the AI must answer with,
// and importAiResult turns the reply back into a roster.

import { endDays, presentationOn, reqCount, ruleSources, shiftRuns, sourceMatches } from './calendar.ts'
import { dateRange, WEEKDAYS } from './dates.ts'
import { responseFor } from './scoring.ts'
import { equalShare, equalTargets, rosterAlerts, shareGroups } from './students.ts'
import { ANY_SHIFT, coversJob, dutyOf, LAST_NIGHT, type Concern, type SwapRequest, presentationPoints, presenterTypes, type DaysBack, type Assignment, type PresenterSource, type MemberResponse, type PresenterAssignment, type Roster, type SessionConfig, type StudentAssignment } from './types.ts'

export const AI_FORMAT_TAG = 'wayneday-roster'

/** The roster in the JSON shape the AI is asked to return. */
export function rosterToJson(config: SessionConfig, roster: Roster) {
  const job = (id: string) => config.jobs.find((j) => j.id === id)?.name ?? id
  const shift = (id: string) => config.shifts.find((s) => s.id === id)?.name ?? id
  const member = (id: string) => config.members.find((m) => m.id === id)?.name ?? id
  const reqJob = (shiftId: string, reqId: string) =>
    job(config.shifts.find((s) => s.id === shiftId)?.requirements.find((r) => r.id === reqId)?.jobId ?? '')
  const byDate = <T extends { date: string }>(xs: T[]) => [...xs].sort((a, b) => a.date.localeCompare(b.date))
  return {
    format: AI_FORMAT_TAG,
    assignments: byDate(roster.assignments).map((a) => ({
      date: a.date,
      shift: shift(a.shiftId),
      job: reqJob(a.shiftId, a.requirementId),
      member: member(a.memberId),
    })),
    students: byDate(roster.students).map((s) => ({
      date: s.date,
      shift: shift(s.shiftId),
      ...(s.requirementId ? { job: reqJob(s.shiftId, s.requirementId) } : {}),
      member: member(s.memberId),
    })),
    presenters: byDate(roster.presenters).map((p) => ({
      date: p.date,
      presentation: config.presentations.find((r) => r.id === p.ruleId)?.name ?? p.ruleId,
      member: member(p.memberId),
    })),
  }
}

/** What the host wants from the AI, and the situation around the roster. */
export interface AiContext {
  /** In the host's words: what to solve (e.g. "R3.32 can't do 4/11; find the fewest changes"). */
  task?: string
  /** Nothing before this date may change (today, and tomorrow unless the host allows it). */
  from?: string
  swaps?: SwapRequest[]
  concerns?: Concern[]
}

export function buildAiPrompt(config: SessionConfig, responses: Record<string, MemberResponse>, roster?: Roster | null, ctx: AiContext = {}): string {
  const job = (id: string) => config.jobs.find((j) => j.id === id)?.name ?? id
  const back = (d: DaysBack) => (d[0] === 1 && d[1] === 1 ? 'the day before' : d[0] === d[1] ? `${d[0]} days before` : `${d[0]}–${d[1]} days before`)
  const describeSource = (src: PresenterSource, daysBack: DaysBack = LAST_NIGHT) => {
    const shift = src.shiftId === ANY_SHIFT ? 'any shift' : [src.shiftId, ...(src.orShiftIds ?? [])].map((id) => `"${shiftName(id)}"`).join(' or ')
    const req = config.shifts.find((x) => x.id === src.shiftId)?.requirements.find((r) => r.id === src.placeId)
    const place = src.jobId ? ` in ${job(src.jobId)}` : req ? ` (${req.jobId ? job(req.jobId) : 'that place'})` : ''
    return `at least ${src.count} who worked ${shift}${place} ${src.when === 'same' ? 'that same day' : back(daysBack)}`
  }
  const shiftName = (id: string) => config.shifts.find((s) => s.id === id)?.name ?? id
  const days = dateRange(config.startDate, config.endDate)
  const workers = config.members.filter((m) => m.type !== 'student')
  const students = config.members.filter((m) => m.type === 'student')

  const hospital = config.rosterMode === 'hospital'
  const lines: string[] = []
  lines.push(
    hospital
      ? `You are arranging medical students onto hospital duty shifts ("${config.title}"). The residents' and staff roster is FIXED by the hospital; place the students (and pick presenters) so every rule below holds.`
      : `You are scheduling hospital duty shifts ("${config.title}"). Produce a complete roster that satisfies every rule below.`,
  )
  if (ctx.task?.trim()) {
    lines.push('')
    lines.push('## What to do')
    lines.push(ctx.task.trim())
    if (roster) lines.push('Start from the current roster below and change as few places and presenters as possible.')
  }
  lines.push('')
  lines.push(`## Period\n${config.startDate} to ${config.endDate} (${days.length} days).`)
  if (config.holidays.length) lines.push(`Holidays (count as weekend days for fairness): ${config.holidays.join(', ')}.`)
  lines.push('')
  lines.push(hospital ? '## Shifts and student places (weekly pattern)' : '## Shifts and positions (weekly pattern)')
  for (const s of config.shifts) {
    const reqs = s.requirements
      .map((r) =>
        hospital
          ? `${r.min ? `${r.min}–${r.count}` : `up to ${r.count}`} student(s)${r.jobId ? ` in ${job(r.jobId)}` : ''}`
          : `${r.count} × ${r.jobId ? job(r.jobId) : 'any job'} (${r.memberType === 'any' ? 'resident or staff' : r.memberType})`,
      )
      .join(', ')
    lines.push(`- "${s.name}" ${s.start}–${s.end}${endDays(s) ? ` (ends ${endDays(s) === 1 ? 'the next day' : `${endDays(s)} days later`})` : ''}, runs on ${s.days.map((d) => WEEKDAYS[d]).join('/') || 'no regular days'}: ${reqs}`)
  }
  if (config.overrides.length) {
    lines.push('')
    lines.push('## Date exceptions (these override the weekly pattern)')
    for (const o of [...config.overrides].sort((a, b) => a.date.localeCompare(b.date))) {
      const shift = config.shifts.find((s) => s.id === o.shiftId)
      if (!shift) continue
      if (!shiftRuns(config, shift, o.date)) lines.push(`- ${o.date}: "${shift.name}" does not run.`)
      else {
        const counts = shift.requirements.map((r) => `${reqCount(config, shift, r, o.date)} × ${r.jobId ? job(r.jobId) : hospital ? 'students' : 'any job'}`).join(', ')
        lines.push(`- ${o.date}: "${shift.name}" runs with ${counts}.`)
      }
    }
  }
  lines.push('')
  if (hospital && config.noDuty) {
    lines.push('## Hospital roster')
    lines.push('Not known yet: arrange the students without residents or staff, and leave "assignments" empty.')
  } else if (hospital) {
    lines.push('## Fixed roster from the hospital (do not change)')
    lines.push('date | shift | role | person')
    for (const a of [...config.duty].sort((x, y) => x.date.localeCompare(y.date))) {
      const who = config.members.find((m) => m.id === a.memberId)
      lines.push(`${a.date} | ${shiftName(a.shiftId)} | ${a.requirementId} | ${who?.name ?? '?'}`)
    }
  } else {
    lines.push('## Residents and staff')
    for (const m of workers) lines.push(personLine(config, responses, m.id, job, shiftName))
  }
  if (students.length) {
    const st = config.students
    lines.push('')
    lines.push('## Students')
    lines.push(
      hospital
        ? [
            st.auto
              ? (() => {
                  const { total, base, extra } = equalShare(config)
                  const groups = shareGroups(config)
                  if (groups.length > 1) {
                    const studs = config.members.filter((m) => m.type === 'student')
                    const targets = equalTargets(config)
                    return `Fill every student place up to its maximum (${total} student-shifts). Students who can take the same places share them as equally as possible within their group: ${groups
                      .map((g) => `${g.members.map((si) => `"${studs[si].name}"`).join(', ')} each do ${targets[g.members[0]][0]}${targets[g.members[0]][1] > targets[g.members[0]][0] ? ` or ${targets[g.members[0]][1]}` : ''}`)
                      .join('; ')}. Keep a similar mix of each shift slot.`
                  }
                  return `Fill every student place up to its maximum (${total} student-shifts) and share them as equally as possible: each student does ${base}${extra ? ` or ${base + 1}` : ''} shift(s), with a similar mix of each shift slot.`
                })()
              : st.perSlot && Object.keys(st.perSlot).length
              ? `Each student does exactly ${Object.entries(st.perSlot).filter(([, n]) => n > 0).map(([id, n]) => `${n} × "${shiftName(id)}"`).join(' and ')}.`
              : `Each student does ${st.shiftsPerStudent} shift(s).`,
            'Students take the student places above (give the job); every place must have at least its minimum number of students.',
            st.minGap ? `A student's shifts must be at least ${st.minGap} days apart.` : '',
            st.points?.on
              ? `Points: a weekday shift is worth ${st.points.weekday}, a weekend or holiday shift ${st.points.weekend}${
                  Object.entries(st.points.shifts ?? {}).filter(([, m]) => m !== 1).length
                    ? `, multiplied by ${Object.entries(st.points.shifts ?? {}).filter(([, m]) => m !== 1).map(([id, m]) => `${m} for "${shiftName(id)}"`).join(', ')}`
                    : ''
                }${
                  Object.keys(st.points.fixed ?? {}).length
                    ? `; these shifts have points set by hand, used instead of the calculation: ${Object.entries(st.points.fixed ?? {})
                        .sort()
                        .map(([k, v]) => {
                          const [slot, when] = k.split('|')
                          return `"${shiftName(slot)}" ${when === 'weekday' ? 'on weekdays' : when === 'weekend' ? 'on weekends/holidays' : `on ${when}`} = ${v}`
                        })
                        .join(', ')} (a date's own points beat the weekday/weekend ones)`
                    : ''
                }${
                  Object.keys(config.datePoints ?? {}).length
                    ? `; these dates have their own points: ${Object.entries(config.datePoints ?? {}).sort().map(([d, v]) => `${d} = ${v}`).join(', ')}`
                    : ''
                }. Keep every student's total points as equal as possible (after keeping their number of shifts equal)${st.points.presentations ? ", counting each student's presentation points too (whoever presents less should get heavier shifts)" : ''}.`
              : '',
            st.avoidRepeatResident ? 'A student should not meet the same resident twice.' : '',
            st.avoidRepeatStaff ? 'A student should not meet the same staff member twice.' : '',
            st.avoidRepeatPartner ? 'The same two students should never be together twice.' : '',
            st.wantPartner ? 'Every student should have a fellow student on at least one shift.' : '',
            'Spread students so every resident and every staff member is on duty with students about equally often. Say clearly if any of these cannot be met.',
          ]
            .filter(Boolean)
            .join(' ')
        : `Students do not fill positions. Each student joins ${st.shiftsPerStudent} shift(s) of ${st.shiftIds.map(shiftName).map((n) => `"${n}"`).join(' or ') || '(none set)'}, at most ${st.maxPerShift} student(s) per shift. Spread students so every resident and every staff member is on duty with students about equally often.`,
    )
    for (const m of students) lines.push(personLine(config, responses, m.id, job, shiftName))
  }
  if (config.presentations.length) {
    lines.push('')
    lines.push('## Presentations')
    for (const r of config.presentations) {
      lines.push(
        `- "${r.name}" (each presentation counts as ${presentationPoints(r)} point(s)) on ${[r.days.map((d) => WEEKDAYS[d]).join('/'), (r.dates ?? []).join(', ')].filter(Boolean).join(' and on ') || 'no regular days'}: ${r.count} presenter(s)${ruleSources(r).length ? `, including ${ruleSources(r).map((src) => describeSource(src, r.daysBack)).join(' and ')}` : ''}. Presenters can be: ${presenterTypes(config, r).join(', ')}. Share presentations evenly.`,
      )
      const changes = config.presentationOverrides.filter((o) => o.ruleId === r.id).sort((x, y) => x.date.localeCompare(y.date))
      for (const o of changes) {
        const p = presentationOn(config, r, o.date)
        lines.push(`  - ${o.date}: ${p ? `${p.count} presenter(s)${p.sources.length ? `, including ${p.sources.map((src) => describeSource(src, p.daysBack)).join(' and ')}` : ''}` : 'no presentation'}`)
      }
    }
  }
  lines.push('')
  lines.push('## Hard rules')
  if (hospital) {
    lines.push('1. Keep the hospital roster exactly as given.')
    lines.push('2. Each student does exactly their number of shifts, never on an UNAVAILABLE date, never two shifts closer together than their minimum interval, and always on their MUST-work dates.')
    lines.push('3. Never more students on one shift than the limit.')
  } else {
    lines.push('1. Every position on every day is filled by exactly one eligible resident/staff member (matching type and job).')
    lines.push('2. Nobody works two shifts on the same date, or on dates closer together than their minimum interval.')
    lines.push('3. Never schedule someone on an UNAVAILABLE date; always honour MUST-work entries and max-shift caps.')
  }
  lines.push('')
  lines.push('## Extra conditions (highest priority after the hard rules)')
  lines.push(config.extraConditions.trim() || '(none)')
  lines.push('')
  lines.push('## Soft goals, in priority order')
  if (hospital) {
    const st = config.students
    const even = (st.evenSlots ?? []).map((id) => `"${shiftName(id)}"`)
    const goals = [
      config.presentations.length ? 'Each presenter comes from the shift (and place/ward) their presentation draws from; nobody presents twice in a day or two days running.' : '',
      config.presentations.some((r) => !r.dates?.length)
        ? 'Every student presents at each weekly presentation (e.g. a morning round) at least once, and their counts of it are at most 1 apart.'
        : '',
      'Days marked "must try hardest to avoid" (!!!) and "important" (!!) are not worked.',
      st.points?.on && st.points.maxDiff ? `Total points (most minus fewest) are within ${st.points.maxDiff}% of the average.` : '',
      `In each group, each shift slot is shared at most 1 apart${st.points?.on ? ', unless the difference is made up for in points' : ''}${even.length ? ` (${even.join(', ')}: at most 1 apart, made up for in points only if impossible)` : ''}.`,
      'Every resident gets about the same number of shifts with a student, and so does every staff member.',
      config.presentations.length ? 'If possible, nobody presents every other day.' : '',
      'If possible, nobody is on duty every other day three times running (e.g. Mon–Wed–Fri), and "would rather not" (!) days are not worked.',
      '"Spread evenly" students get even spacing (no gap over twice the even spacing); "grouped" students get shifts in pairs at their minimum interval.',
    ].filter(Boolean)
    goals.forEach((g, i) => lines.push(`${i + 1}. ${g}`))
  } else {
    lines.push('1. Equal total shifts among people of the same type, then equal weekend/holiday shifts, then equal counts of each shift.')
    lines.push('2. People who prefer "spread evenly" get the most even spacing; people who prefer "grouped" get shifts near their minimum interval.')
  }
  lines.push('')
  if (roster && (roster.assignments.length || roster.students.length)) {
    lines.push('## Current roster')
    lines.push('Start from this roster and change as few places and presenters as possible:')
    lines.push('```json')
    lines.push(JSON.stringify(rosterToJson(config, roster)))
    lines.push('```')
    lines.push('')
    const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? id
    const alerts = rosterAlerts(config, responses, roster)
    lines.push('## What the current roster breaks')
    lines.push(alerts.length ? alerts.map((a) => `- ${a.level === 'rule' ? 'RULE' : 'preference'}: ${a.text}`).join('\n') : '(nothing)')
    lines.push('')
    const locked = (roster.pinned ?? []).map((k) => {
      const [kind, date, a, b, c] = k.split('|')
      return kind === 's' ? `- ${date} "${shiftName(a)}": "${name(c)}"` : `- ${date} presentation "${config.presentations.find((r) => r.id === a)?.name ?? a}": "${name(b)}"`
    })
    if (ctx.from || locked.length) {
      lines.push('## Do not change')
      if (ctx.from) lines.push(`- Nothing dated before ${ctx.from} (already announced): keep those days exactly as they are.`)
      lines.push(...locked)
      lines.push('')
    }
    const openSwaps = (ctx.swaps ?? []).filter((x) => x.status === 'open' || x.status === 'agreed')
    const openConcerns = (ctx.concerns ?? []).filter((x) => !x.resolved)
    if (openSwaps.length || openConcerns.length) {
      lines.push("## Students' requests")
      for (const x of openSwaps) lines.push(`- "${name(x.memberId)}" asks to swap away their ${x.date} "${shiftName(x.shiftId)}"${x.note ? `: "${x.note}"` : ''}`)
      for (const x of openConcerns) lines.push(`- "${name(x.memberId)}"${x.date ? ` (about ${x.date})` : ''}: "${x.text}"`)
      lines.push('')
    }
  }
  lines.push('## Output format')
  lines.push(
    `First, in one short list, say which rules you could not satisfy (if any) and every change you made, as "date shift/presentation: old → new". Then output the COMPLETE ${hospital ? 'student and presenter lists' : 'roster'} as ONE \`\`\`json code block in exactly this shape, using the exact names above. Keep "format": "${AI_FORMAT_TAG}" so the app can read it back:`,
  )
  lines.push('```json')
  lines.push(
    JSON.stringify({
      format: AI_FORMAT_TAG,
      assignments: hospital ? [] : [{ date: 'YYYY-MM-DD', shift: '<shift name>', job: '<job name>', member: '<name>' }],
      students: students.length
        ? [{ date: 'YYYY-MM-DD', shift: '<shift name>', ...(hospital ? { job: '<job name>' } : {}), member: '<student name>' }]
        : [],
      presenters: config.presentations.length ? [{ date: 'YYYY-MM-DD', presentation: '<presentation name>', member: '<name>' }] : [],
    }),
  )
  lines.push('```')
  return lines.join('\n')
}

function personLine(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  id: string,
  job: (id: string) => string,
  shiftName: (id: string) => string,
) {
  const m = config.members.find((x) => x.id === id)!
  const r = responseFor(responses, m.id)
  const parts = [
    m.type,
    ...(m.type === 'student' ? (m.jobs.length ? [`only in: ${m.jobs.map(job).join(', ')}`] : []) : [m.jobs.length ? `can only do: ${m.jobs.map(job).join(', ')}` : 'can do any job']),
    ...(m.periods ?? []).map((p) => `only in ${job(p.jobId)} from ${p.from} to ${p.to}`),
    `prefers ${r.preference === 'distributed' ? 'shifts spread evenly across the period' : 'shifts grouped close together'}`,
    `at least ${r.minInterval} day(s) between shift dates`,
  ]
  if (m.maxShifts != null) parts.push(`max ${m.maxShifts} shifts`)
  if (r.unavailable.length) parts.push(`UNAVAILABLE on ${[...r.unavailable].sort().join(', ')}`)
  for (const level of [3, 2, 1] as const) {
    const dates = (r.avoid ?? []).filter((x) => x.level === level).map((x) => x.date).sort()
    if (dates.length) parts.push(`${['', 'would rather avoid', 'should avoid (important)', 'must try hardest to avoid'][level]}: ${dates.join(', ')}`)
  }
  if (r.locks.length) parts.push(`MUST work ${r.locks.map((l) => `${shiftName(l.shiftId)} on ${l.date}`).join(', ')}`)
  if (r.note.trim()) parts.push(`note: "${r.note.trim()}"`)
  return `- "${m.name}": ${parts.join('; ')}`
}

export type ImportResult = { ok: true; roster: Roster; skipped: string[] } | { ok: false; error: string }

/** Parse an AI reply (raw JSON or with prose / code fences around it) into a roster. */
export function importAiResult(text: string, config: SessionConfig): ImportResult {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1])
  const candidates = [...fenced.reverse(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  let data: Record<string, unknown> | null = null
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown
      const obj = (Array.isArray(parsed) ? { assignments: parsed } : parsed) as Record<string, unknown>
      const rows = (obj?.assignments as unknown[] | undefined)?.length ?? 0
      const studentRows = Array.isArray(obj?.students) ? (obj.students as unknown[]).length : 0
      if (Array.isArray(obj?.assignments) || Array.isArray(obj?.students)) {
        data = obj
        // Prefer the block tagged with our format (the reply may also echo the template).
        if (obj.format === AI_FORMAT_TAG && rows + studentRows > 1) break
      }
    } catch {
      // try the next candidate
    }
  }
  if (!data) return { ok: false, error: 'Could not find the roster JSON in the reply. Paste the whole answer, including the ```json block.' }

  const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()
  const findMember = (v: unknown) => config.members.find((m) => norm(m.name) === norm(v))
  const findShift = (v: unknown) => config.shifts.find((s) => norm(s.name) === norm(v))
  const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''))
  const skipped: string[] = []

  const assignments: Assignment[] = []
  const filled = new Map<string, number>()
  // Hospital mode: the residents/staff roster is the hospital's; ignore whatever the AI said about it.
  const rows = config.rosterMode === 'hospital' ? [] : ((Array.isArray(data.assignments) ? data.assignments : []) as Record<string, unknown>[])
  if (config.rosterMode === 'hospital') assignments.push(...dutyOf(config))
  for (const row of rows) {
    const shift = findShift(row.shift)
    const member = findMember(row.member)
    const job = config.jobs.find((j) => norm(j.name) === norm(row.job))
    const date = String(row.date ?? '')
    if (!shift || !member || member.type === 'student' || !isDate(date)) {
      skipped.push(`${date} ${String(row.shift)} ${String(row.member)}`)
      continue
    }
    // Pick the matching position that still has room, preferring an exact type match.
    const reqs = shift.requirements
      .filter((r) => (!job || r.jobId === job.id) && (r.memberType === member.type || r.memberType === 'any'))
      .sort((a, b) => Number(b.memberType === member.type) - Number(a.memberType === member.type))
    const req = reqs.find((r) => (filled.get(`${date}|${r.id}`) ?? 0) < reqCount(config, shift, r, date)) ?? reqs[0]
    if (!req) {
      skipped.push(`${date} ${shift.name} ${member.name} (no matching position)`)
      continue
    }
    filled.set(`${date}|${req.id}`, (filled.get(`${date}|${req.id}`) ?? 0) + 1)
    assignments.push({ date, shiftId: shift.id, requirementId: req.id, memberId: member.id })
  }

  const students: StudentAssignment[] = []
  for (const row of (Array.isArray(data.students) ? data.students : []) as Record<string, unknown>[]) {
    const shift = findShift(row.shift)
    const member = findMember(row.member)
    if (!shift || !member || member.type !== 'student' || !isDate(row.date)) {
      skipped.push(`student ${String(row.date)} ${String(row.member)}`)
      continue
    }
    if (config.rosterMode === 'hospital') {
      // Pick the student place (job) on that shift, preferring the job named, then any with room.
      const date = String(row.date)
      const named = config.jobs.find((j) => norm(j.name) === norm(row.job))
      const reqs = shift.requirements
        .filter((r) => !named || r.jobId === named.id)
        .sort((a, b) => Number(coversJob(member, b.jobId, date)) - Number(coversJob(member, a.jobId, date)))
      const req =
        reqs.find((r) => students.filter((x) => x.date === date && x.requirementId === r.id).length < reqCount(config, shift, r, date)) ?? reqs[0]
      students.push({ date, shiftId: shift.id, ...(req ? { requirementId: req.id } : {}), memberId: member.id })
      continue
    }
    students.push({ date: String(row.date), shiftId: shift.id, memberId: member.id })
  }

  const presenters: PresenterAssignment[] = []
  for (const row of (Array.isArray(data.presenters) ? data.presenters : []) as Record<string, unknown>[]) {
    const rule = config.presentations.find((r) => norm(r.name) === norm(row.presentation)) ?? (config.presentations.length === 1 ? config.presentations[0] : undefined)
    const member = findMember(row.member)
    const date = String(row.date ?? '')
    if (!rule || !member || !isDate(date)) {
      skipped.push(`presenter ${date} ${String(row.member)}`)
      continue
    }
    const yesterday = new Date(Date.parse(date + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10)
    const fromLastNight = (x: { date: string; shiftId: string; requirementId?: string; memberId: string }) =>
      x.date === yesterday && x.memberId === member.id && ruleSources(rule).some((src) => src.when !== 'same' && sourceMatches(config, src, x.shiftId, x.requirementId))
    const postCall = assignments.some(fromLastNight) || students.some(fromLastNight)
    presenters.push({ date, ruleId: rule.id, memberId: member.id, postCall })
  }

  if (config.rosterMode === 'hospital' ? students.length === 0 : assignments.length === 0) {
    return { ok: false, error: 'No rows matched the session’s shift and member names.' }
  }
  return { ok: true, roster: { assignments, students, presenters }, skipped }
}
