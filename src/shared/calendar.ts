// Which shifts run on a date and how many people each position needs, after per-date overrides.
import { weekday } from './dates.ts'
import { ANY_SHIFT, DEFAULT_POINTS, LAST_NIGHT, type DaysBack, type PresentationRule, type PresenterSource, type Requirement, type SessionConfig, type ShiftSlot } from './types.ts'

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

/** Fewest people a position needs on a date (hospital-mode student places), never above that day's count. */
export function reqMin(config: SessionConfig, shift: ShiftSlot, req: Requirement, date: string): number {
  return Math.min(req.min ?? 0, reqCount(config, shift, req, date))
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
/** Does a rule run on this date when nothing was changed for it: one of its weekdays, or one of its dates? */
export const presentationUsually = (rule: PresentationRule, date: string) => rule.days.includes(weekday(date)) || (rule.dates ?? []).includes(date)

/** Who must be among a rule's presenters (rules made before sources had one shift and a count). */
export function ruleSources(rule: PresentationRule): PresenterSource[] {
  return rule.sources ?? (rule.fromCount > 0 ? [{ shiftId: rule.fromShiftId, count: rule.fromCount, when: 'before' }] : [])
}

/** Days before a presentation a source looks at: 0 for a same-day source, else each day in `daysBack`. */
export function sourceOffsets(src: PresenterSource, daysBack: DaysBack): number[] {
  if (src.when === 'same') return [0]
  return Array.from({ length: daysBack[1] - daysBack[0] + 1 }, (_, i) => daysBack[0] + i)
}

/** Was someone on this shift (and place) one of the people a source draws from? */
export function sourceMatches(config: SessionConfig, src: PresenterSource, shiftId: string, placeId?: string) {
  if (src.shiftId !== ANY_SHIFT && src.shiftId !== shiftId) return false
  if (src.placeId && src.placeId !== placeId) return false
  if (!src.jobId) return true
  return config.shifts.find((s) => s.id === shiftId)?.requirements.find((r) => r.id === placeId)?.jobId === src.jobId
}

/**
 * A rule on one date, after that date's changes: how many present, and who must be among them.
 * A date's "from" number applies when the rule has a single source.
 */
export function presentationOn(
  config: SessionConfig,
  rule: PresentationRule,
  date: string,
): { count: number; fromCount: number; sources: PresenterSource[]; daysBack: DaysBack } | null {
  const o = config.presentationOverrides.find((x) => x.date === date && x.ruleId === rule.id)
  const active = o?.active ?? presentationUsually(rule, date)
  if (!active) return null
  const count = o?.count ?? rule.count
  let sources = ruleSources(rule)
  if (o?.fromCount !== undefined && sources.length === 1) sources = [{ ...sources[0], count: o.fromCount }]
  // Never ask for more than the presentations that day.
  let left = count
  sources = sources.map((s) => {
    const n = Math.max(0, Math.min(s.count, left))
    left -= n
    return { ...s, count: n }
  })
  return { count, fromCount: count - left, sources, daysBack: o?.daysBack ?? rule.daysBack ?? LAST_NIGHT }
}

/** Points a date's shifts are worth, before the slot multiplier: that date's own, else weekday or weekend/holiday. */
export function dayPoints(config: SessionConfig, date: string): number {
  const own = config.datePoints?.[date]
  if (own !== undefined) return own
  const p = config.students.points ?? DEFAULT_POINTS
  const wd = weekday(date)
  return wd === 0 || wd === 6 || config.holidays.includes(date) ? p.weekend : p.weekday
}

/** Points one student earns for a shift slot on a date (1 each when points are off). */
export function shiftPoints(config: SessionConfig, shiftId: string, date: string): number {
  const p = config.students.points
  if (!p?.on) return 1
  return dayPoints(config, date) * (p.shifts?.[shiftId] ?? 1)
}

/** Points for display: whole numbers as is, others to one decimal. */
export const fmtPoints = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

// ---------- shift times ----------

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Days after its start day that a shift ends. */
export function endDays(shift: Pick<ShiftSlot, 'start' | 'end' | 'endDays'>): number {
  return shift.endDays ?? (minutes(shift.end) <= minutes(shift.start) ? 1 : 0)
}

/** Minutes from the start of its first day to its start and end. */
export function shiftSpan(shift: Pick<ShiftSlot, 'start' | 'end' | 'endDays'>) {
  const start = minutes(shift.start)
  return { start, end: endDays(shift) * 1440 + minutes(shift.end) }
}

/** How long a shift is, in hours. */
export function shiftHours(shift: Pick<ShiftSlot, 'start' | 'end' | 'endDays'>): number {
  const { start, end } = shiftSpan(shift)
  return Math.max(0, end - start) / 60
}

/** "16:00–08:00", or "08:00–20:00 (+1)" when the end is a different day than you'd guess from the times. */
export function shiftTimes(shift: Pick<ShiftSlot, 'start' | 'end' | 'endDays'>): string {
  const days = endDays(shift)
  const guessed = minutes(shift.end) <= minutes(shift.start) ? 1 : 0
  return `${shift.start}–${shift.end}${days !== guessed || days > 1 ? ` (+${days})` : ''}`
}
