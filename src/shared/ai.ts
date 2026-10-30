// Hand-off to an external AI for conditions the built-in solver can't express (e.g. morning rounds).
// The prompt carries the full roster problem; the AI answers with JSON that importAiResult turns back into assignments.

import { dateRange, WEEKDAYS } from './dates.ts'
import { responseFor } from './solver.ts'
import type { Assignment, MemberResponse, Schedule, SessionConfig } from './types.ts'

export function buildAiPrompt(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  current?: Schedule | null,
): string {
  const job = (id: string) => config.jobs.find((j) => j.id === id)?.name ?? id
  const shiftName = (id: string) => config.shifts.find((s) => s.id === id)?.name ?? id
  const member = (id: string) => config.members.find((m) => m.id === id)?.name ?? id
  const days = dateRange(config.startDate, config.endDate)

  const lines: string[] = []
  lines.push(`You are scheduling hospital duty shifts ("${config.title}"). Produce a complete roster that satisfies every rule below.`)
  lines.push('')
  lines.push(`## Period\n${config.startDate} to ${config.endDate} (${days.length} days).`)
  if (config.holidays.length) lines.push(`Holidays (count as weekend days for fairness): ${config.holidays.join(', ')}.`)
  lines.push('')
  lines.push('## Shifts and positions')
  for (const s of config.shifts) {
    const reqs = s.requirements
      .map((r) => `${r.count} × ${job(r.jobId)} (${r.memberType === 'any' ? 'resident or staff' : r.memberType})`)
      .join(', ')
    lines.push(`- "${s.name}" ${s.start}–${s.end}, runs on ${s.days.map((d) => WEEKDAYS[d]).join('/')}: ${reqs}`)
  }
  lines.push('')
  lines.push('## People')
  for (const m of config.members) {
    const r = responseFor(responses, m.id)
    const parts = [
      m.type,
      m.jobs.length ? `can only do: ${m.jobs.map(job).join(', ')}` : 'can do any job',
      `prefers ${r.preference === 'distributed' ? 'shifts spread evenly across the period' : 'shifts grouped close together'}`,
      `at least ${r.minInterval} day(s) between shift dates`,
    ]
    if (m.maxShifts != null) parts.push(`max ${m.maxShifts} shifts`)
    if (r.unavailable.length) parts.push(`UNAVAILABLE on ${[...r.unavailable].sort().join(', ')}`)
    if (r.locks.length) parts.push(`MUST work ${r.locks.map((l) => `${shiftName(l.shiftId)} on ${l.date}`).join(', ')}`)
    if (r.note.trim()) parts.push(`note: "${r.note.trim()}"`)
    lines.push(`- "${m.name}": ${parts.join('; ')}`)
  }
  lines.push('')
  lines.push('## Hard rules')
  lines.push('1. Every position on every day is filled by exactly one eligible person (matching type and job).')
  lines.push('2. Nobody works two shifts on the same date, or on dates closer together than their minimum interval.')
  lines.push('3. Never schedule someone on an UNAVAILABLE date; always honour MUST-work entries and max-shift caps.')
  lines.push('')
  lines.push('## Extra conditions (highest priority after the hard rules)')
  lines.push(config.extraConditions.trim() || '(none)')
  lines.push('')
  lines.push('## Soft goals, in priority order')
  lines.push('1. Equal total shifts among people of the same type, then equal weekend/holiday shifts, then equal counts of each shift.')
  lines.push('2. People who prefer "spread evenly" get the most even spacing; people who prefer "grouped" get shifts near their minimum interval.')
  if (current?.assignments.length) {
    lines.push('')
    lines.push('## Current draft (improve it rather than starting over if it mostly works)')
    for (const a of [...current.assignments].sort((x, y) => x.date.localeCompare(y.date))) {
      const req = config.shifts.find((s) => s.id === a.shiftId)?.requirements.find((r) => r.id === a.requirementId)
      lines.push(`${a.date} | ${shiftName(a.shiftId)} | ${req ? job(req.jobId) : '?'} | ${member(a.memberId)}`)
    }
  }
  lines.push('')
  lines.push('## Output format')
  lines.push('First check the rules and briefly list any you cannot satisfy. Then output ONLY this JSON in a ```json code block, one entry per filled position, using the exact names above:')
  lines.push('```json')
  lines.push('{"assignments": [{"date": "YYYY-MM-DD", "shift": "<shift name>", "job": "<job name>", "member": "<person name>"}]}')
  lines.push('```')
  return lines.join('\n')
}

export type ImportResult = { ok: true; assignments: Assignment[]; skipped: string[] } | { ok: false; error: string }

/** Parse an AI reply (raw JSON or with surrounding prose / code fences) into assignments. */
export function importAiResult(text: string, config: SessionConfig): ImportResult {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1])
  const candidates = [...fenced.reverse(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  let data: unknown
  for (const c of candidates) {
    try {
      data = JSON.parse(c)
      break
    } catch {
      // try the next candidate
    }
  }
  const rows = Array.isArray(data) ? data : (data as { assignments?: unknown })?.assignments
  if (!Array.isArray(rows)) return { ok: false, error: 'Could not find an "assignments" JSON array in the text.' }

  const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()
  const assignments: Assignment[] = []
  const skipped: string[] = []
  const filled = new Map<string, number>()
  for (const row of rows as Record<string, unknown>[]) {
    const shift = config.shifts.find((s) => norm(s.name) === norm(row.shift))
    const member = config.members.find((m) => norm(m.name) === norm(row.member))
    const job = config.jobs.find((j) => norm(j.name) === norm(row.job))
    const date = String(row.date ?? '')
    if (!shift || !member || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      skipped.push(`${date} ${String(row.shift)} ${String(row.member)}`)
      continue
    }
    // Pick the matching requirement that still has room, preferring an exact type match.
    const reqs = shift.requirements
      .filter((r) => (!job || r.jobId === job.id) && (r.memberType === member.type || r.memberType === 'any'))
      .sort((a, b) => Number(b.memberType === member.type) - Number(a.memberType === member.type))
    const req = reqs.find((r) => (filled.get(`${date}|${r.id}`) ?? 0) < r.count) ?? reqs[0]
    if (!req) {
      skipped.push(`${date} ${shift.name} ${member.name} (no matching position)`)
      continue
    }
    filled.set(`${date}|${req.id}`, (filled.get(`${date}|${req.id}`) ?? 0) + 1)
    assignments.push({ date, shiftId: shift.id, requirementId: req.id, memberId: member.id })
  }
  if (assignments.length === 0) return { ok: false, error: 'No rows matched the session’s shift and member names.' }
  return { ok: true, assignments, skipped }
}
