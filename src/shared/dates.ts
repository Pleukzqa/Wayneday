// Calendar helpers on plain YYYY-MM-DD strings, computed in UTC so time zones never shift a date.

const DAY_MS = 86_400_000

export function parseDate(s: string): number {
  const [y, m, d] = s.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(s: string, n: number): string {
  return formatDate(parseDate(s) + n * DAY_MS)
}

/** Whole days from a to b (b - a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((parseDate(b) - parseDate(a)) / DAY_MS)
}

export function dateRange(start: string, end: string): string[] {
  if (!isDate(start) || !isDate(end)) return []
  const out: string[] = []
  for (let d = start; d <= end && out.length < 400; d = addDays(d, 1)) out.push(d)
  return out
}

export function weekday(s: string): number {
  return new Date(parseDate(s)).getUTCDay()
}

export function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseDate(s))
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function shortDate(s: string): string {
  const d = new Date(parseDate(s))
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`
}
