// The roster table's columns and what's in each cell — used by the on-screen table and every export.
import { t } from './i18n.ts'
import { presentationOn, reqCount, shiftRuns, shiftTimes } from './calendar.ts'
import { DUTY_ROLES, isOneDay, type DutyRole, type Roster, type SessionConfig } from './types.ts'

export type Column =
  | { kind: 'position'; key: string; shiftId: string; requirementId: string; title: string }
  | { kind: 'students'; key: string; shiftId: string; title: string }
  | { kind: 'duty'; key: string; shiftId: string; role: DutyRole; title: string }
  | { kind: 'place'; key: string; shiftId: string; requirementId: string; title: string }
  /** One weekly presentation, or all one-day ones together (each labelled with its name). */
  | { kind: 'presenters'; key: string; ruleIds: string[]; title: string }

export function columnsFor(config: SessionConfig): Column[] {
  const job = (id: string) => config.jobs.find((j) => j.id === id)?.name ?? ''
  const oneDay = config.presentations.filter(isOneDay)
  const presenters: Column[] = [
    ...config.presentations.filter((r) => !isOneDay(r)).map((r): Column => ({ kind: 'presenters', key: `pr-${r.id}`, ruleIds: [r.id], title: r.name })),
    ...(oneDay.length ? [{ kind: 'presenters' as const, key: 'pr-one-day', ruleIds: oneDay.map((r) => r.id), title: t('One-day presentations') }] : []),
  ]
  if (config.rosterMode === 'hospital') {
    // The hospital's people per shift, then each student place.
    return [
      ...config.shifts.flatMap((s): Column[] => [
        ...(config.noDuty ? [] : DUTY_ROLES).map((role): Column => ({ kind: 'duty', key: `d-${s.id}-${role}`, shiftId: s.id, role, title: `${s.name} · ${t(role === 'resident' ? 'residents' : 'staff')}` })),
        ...s.requirements.map(
          (r): Column => ({ kind: 'place', key: r.id, shiftId: s.id, requirementId: r.id, title: r.jobId ? `${s.name} · ${t(r.count > 1 ? '{job} students' : '{job} student', { job: job(r.jobId) })}` : `${s.name} · ${t('students')}` }),
        ),
      ]),
      ...presenters,
    ]
  }
  const hasStudents = config.members.some((m) => m.type === 'student')
  return [
    ...config.shifts.flatMap((s): Column[] => [
      ...s.requirements.map(
        (r): Column => ({
          kind: 'position',
          key: r.id,
          shiftId: s.id,
          requirementId: r.id,
          title:
            s.requirements.length === 1 && config.jobs.length <= 1
              ? `${s.name} (${shiftTimes(s)})`
              : `${s.name}${r.jobId ? ` · ${job(r.jobId)}` : ''}${r.memberType === 'any' ? '' : ` (${r.memberType})`}`,
        }),
      ),
      ...(hasStudents && config.students.shiftIds.includes(s.id)
        ? [{ kind: 'students' as const, key: `st-${s.id}`, shiftId: s.id, title: `${s.name} · ${t('students')}` }]
        : []),
    ]),
    ...presenters,
  ]
}

/** A presenters column on a date: each of its presentations that happens that day, with who presents; null = none. */
export function presenterParts(config: SessionConfig, roster: Roster, c: Extract<Column, { kind: 'presenters' }>, date: string) {
  const today = config.presentations.filter((r) => c.ruleIds.includes(r.id) && presentationOn(config, r, date))
  if (!today.length) return null
  return today.map((rule) => ({ rule, ids: roster.presenters.filter((p) => p.date === date && p.ruleId === rule.id).map((p) => p.memberId) }))
}

/** Member ids in one cell of the roster table, or null when that column doesn't apply that day. */
export function cellIds(config: SessionConfig, roster: Roster, c: Column, date: string): string[] | null {
  if (c.kind === 'presenters') {
    const today = presenterParts(config, roster, c, date)
    return today ? today.flatMap((x) => x.ids) : null
  }
  const shift = config.shifts.find((s) => s.id === c.shiftId)
  if (!shift || !shiftRuns(config, shift, date)) return null
  if (c.kind === 'duty') return roster.assignments.filter((a) => a.date === date && a.shiftId === c.shiftId && a.requirementId === c.role).map((a) => a.memberId)
  if (c.kind === 'students') return roster.students.filter((s) => s.date === date && s.shiftId === c.shiftId).map((s) => s.memberId)
  const req = shift.requirements.find((r) => r.id === c.requirementId)
  if (!req || reqCount(config, shift, req, date) === 0) return null
  if (c.kind === 'place') return roster.students.filter((s) => s.date === date && s.shiftId === c.shiftId && s.requirementId === c.requirementId).map((s) => s.memberId)
  return roster.assignments.filter((a) => a.date === date && a.shiftId === c.shiftId && a.requirementId === c.requirementId).map((a) => a.memberId)
}

/** Names in one cell of the roster table, or null when that column doesn't apply that day. */
export function cellNames(config: SessionConfig, roster: Roster, c: Column, date: string): string[] | null {
  const ids = cellIds(config, roster, c, date)
  if (!ids) return null
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  if (c.kind === 'presenters') {
    // A combined one-day column labels each presentation: "CCR Chest: Ann ●, Ben".
    return presenterParts(config, roster, c, date)!.map(({ rule, ids: who }) => {
      const list = who.map((id) => name(id) + (roster.presenters.find((p) => p.date === date && p.ruleId === rule.id && p.memberId === id)?.postCall ? ' ●' : '')).join(', ')
      return c.ruleIds.length > 1 ? `${rule.name}: ${list || '—'}` : list
    }).filter(Boolean)
  }
  return ids.map(name)
}
