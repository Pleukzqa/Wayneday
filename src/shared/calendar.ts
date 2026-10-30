// Which shifts run on a date and how many people each position needs, after per-date overrides.
import { weekday } from './dates.ts'
import type { PresentationRule, Requirement, SessionConfig, ShiftSlot } from './types.ts'

export function overrideFor(config: SessionConfig, date: string, shiftId: string) {
  return config.overrides.find((o) => o.date === date && o.shiftId === shiftId)
}

export function shiftRuns(config: SessionConfig, shift: ShiftSlot, date: string): boolean {
  return overrideFor(config, date, shift.id)?.active ?? shift.days.includes(weekday(date))
}

export function reqCount(config: SessionConfig, shift: ShiftSlot, req: Requirement, date: string): number {
  if (!shiftRuns(config, shift, date)) return 0
  return overrideFor(config, date, shift.id)?.counts?.[req.id] ?? req.count
}

export function shiftsOn(config: SessionConfig, date: string): ShiftSlot[] {
  return config.shifts.filter((s) => shiftRuns(config, s, date))
}

/** Shift slots a member type can be locked into. */
export function shiftsForType(config: SessionConfig, type: string): ShiftSlot[] {
  if (type === 'student') {
    return config.rosterMode === 'hospital'
      ? config.shifts.filter((s) => s.requirements.length > 0)
      : config.shifts.filter((s) => config.students.shiftIds.includes(s.id))
  }
  return config.shifts.filter((s) => s.requirements.some((r) => r.memberType === 'any' || r.memberType === type))
}

/** Presentation numbers on a date after per-date changes, or null when there is none that day. */
export function presentationOn(config: SessionConfig, rule: PresentationRule, date: string): { count: number; fromCount: number } | null {
  const o = config.presentationOverrides.find((x) => x.date === date && x.ruleId === rule.id)
  const active = o?.active ?? rule.days.includes(weekday(date))
  if (!active) return null
  const count = o?.count ?? rule.count
  return { count, fromCount: Math.min(count, o?.fromCount ?? rule.fromCount) }
}
