// Roster exports: CSV, Excel, PNG, Google Sheets (Drive) and calendars (Google Calendar, .ics, Google CSV).
import { t } from './shared/i18n.ts'
import { googleToken } from './google.ts'
import { endDays, presentationOn, reqCount, shiftRuns, shiftTimes } from './shared/calendar.ts'
import { addDays, dateRange, shortDate, weekday } from './shared/dates.ts'
import { buildProblem, statsFor } from './shared/solver.ts'
import { studentExposure, studentSummaryTable } from './shared/students.ts'
import { DUTY_ROLES, type Assignment, type DutyRole, type MemberResponse, type Roster, type SessionConfig } from './shared/types.ts'

export type Column =
  | { kind: 'position'; key: string; shiftId: string; requirementId: string; title: string }
  | { kind: 'students'; key: string; shiftId: string; title: string }
  | { kind: 'duty'; key: string; shiftId: string; role: DutyRole; title: string }
  | { kind: 'place'; key: string; shiftId: string; requirementId: string; title: string }
  | { kind: 'presenters'; key: string; ruleId: string; title: string }

export function columnsFor(config: SessionConfig): Column[] {
  const job = (id: string) => config.jobs.find((j) => j.id === id)?.name ?? ''
  const presenters = config.presentations.map((r): Column => ({ kind: 'presenters', key: `pr-${r.id}`, ruleId: r.id, title: r.name }))
  if (config.rosterMode === 'hospital') {
    // The hospital's people per shift, then each student place.
    return [
      ...config.shifts.flatMap((s): Column[] => [
        ...DUTY_ROLES.map((role): Column => ({ kind: 'duty', key: `d-${s.id}-${role}`, shiftId: s.id, role, title: `${s.name} · ${t(role === 'resident' ? 'residents' : 'staff')}` })),
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

/** Member ids in one cell of the roster table, or null when that column doesn't apply that day. */
export function cellIds(config: SessionConfig, roster: Roster, c: Column, date: string): string[] | null {
  if (c.kind === 'presenters') {
    const rule = config.presentations.find((r) => r.id === c.ruleId)
    if (!rule || !presentationOn(config, rule, date)) return null
    return roster.presenters.filter((p) => p.date === date && p.ruleId === c.ruleId).map((p) => p.memberId)
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
    return ids.map((id) => name(id) + (roster.presenters.find((p) => p.date === date && p.ruleId === c.ruleId && p.memberId === id)?.postCall ? ' ●' : ''))
  }
  return ids.map(name)
}

/** Date rows × columns, names joined in each cell. */
export function rosterTable(config: SessionConfig, roster: Roster) {
  const cols = columnsFor(config)
  const header = ['Date', 'Day', ...cols.map((c) => c.title)]
  const rows = dateRange(config.startDate, config.endDate).map((date) => [
    date,
    shortDate(date).split(' ')[0],
    ...cols.map((c) => cellNames(config, roster, c, date)?.join(', ') ?? '—'),
  ])
  return { header, rows }
}

export function personTable(config: SessionConfig, responses: Record<string, MemberResponse>, roster: Roster) {
  const { assignments } = roster
  const p = buildProblem(config, responses)
  // Map assignments onto seats to reuse the solver's stats.
  const assign = new Int32Array(p.seats.length).fill(-1)
  const used = new Set<Assignment>()
  for (const s of p.seats) {
    const a = assignments.find((x) => !used.has(x) && x.date === s.date && x.shiftId === s.shiftId && x.requirementId === s.requirementId)
    if (!a) continue
    used.add(a)
    assign[s.index] = config.members.findIndex((m) => m.id === a.memberId)
  }
  const stats = statsFor(p, assign)
  if (config.rosterMode === 'hospital') {
    // The hospital roster isn't seat-based; count its shifts directly.
    config.members.forEach((m, i) => {
      const mine = assignments.filter((a) => a.memberId === m.id)
      const byShift: Record<string, number> = {}
      for (const a of mine) byShift[a.shiftId] = (byShift[a.shiftId] ?? 0) + 1
      stats[i] = { ...stats[i], total: mine.length, weekend: mine.filter((a) => [0, 6].includes(weekday(a.date)) || config.holidays.includes(a.date)).length, byShift }
    })
  }
  const hasStudents = config.members.some((m) => m.type === 'student')
  const exposure = studentExposure(config, assignments, roster.students)
  const header = [
    'Name',
    'Type',
    'Total',
    'Weekend/holiday',
    ...config.shifts.map((s) => s.name),
    ...(hasStudents ? ['With students'] : []),
    ...(config.presentations.length ? ['Presentations'] : []),
    'Dates',
  ]
  const rows = config.members.map((m, i) => {
    const studentDates = roster.students.filter((s) => s.memberId === m.id).map((s) => s.date)
    const isStudent = m.type === 'student'
    return [
      m.name,
      m.type,
      String(isStudent ? studentDates.length : stats[i].total),
      String(isStudent ? studentDates.filter((d) => [0, 6].includes(weekday(d)) || config.holidays.includes(d)).length : stats[i].weekend),
      ...config.shifts.map((s) =>
        String(isStudent ? roster.students.filter((x) => x.memberId === m.id && x.shiftId === s.id).length : (stats[i].byShift[s.id] ?? 0)),
      ),
      ...(hasStudents ? [isStudent ? '—' : String(exposure[m.id] ?? 0)] : []),
      ...(config.presentations.length ? [String(roster.presenters.filter((x) => x.memberId === m.id).length)] : []),
      [...assignments.filter((a) => a.memberId === m.id).map((a) => a.date), ...studentDates].sort().join(' '),
    ]
  })
  return { header, rows }
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
export const toCsv = (t: { header: string[]; rows: string[][] }) =>
  [t.header, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\r\n')

interface DownloadsCapability {
  save(r: { filename: string; data: Blob }): Promise<unknown>
}

/** True inside a claude.ai artifact, where files go through the viewer's Downloads capability. */
export const IN_ARTIFACT = typeof window !== 'undefined' && Boolean(window.claude)

async function download(blob: Blob, filename: string) {
  const downloads = window.claude ? ((await window.claude.use('downloads').catch(() => null)) as DownloadsCapability | null) : null
  if (downloads) {
    try {
      await downloads.save({ filename, data: blob })
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'declined') throw new Error('Download cancelled.')
      throw new Error('Downloads aren’t available in this view.')
    }
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const fileBase = (config: SessionConfig) =>
  `${config.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'roster'}-${config.startDate}`

export async function exportCsv(config: SessionConfig, roster: Roster) {
  // BOM so Excel reads Thai names correctly.
  await download(new Blob(['\ufeff' + toCsv(rosterTable(config, roster))], { type: 'text/csv;charset=utf-8' }), `${fileBase(config)}.csv`)
}

export async function exportXlsx(config: SessionConfig, responses: Record<string, MemberResponse>, roster: Roster) {
  const { default: ExcelJS } = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  const add = (name: string, t: { header: string[]; rows: string[][] }, weekendCol?: number) => {
    const ws = wb.addWorksheet(name)
    ws.addRow(t.header).font = { bold: true }
    for (const r of t.rows) {
      const row = ws.addRow(r)
      if (weekendCol !== undefined) {
        const wd = weekday(r[weekendCol])
        if (wd === 0 || wd === 6 || config.holidays.includes(r[weekendCol])) {
          row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF1E3' } }
        }
      }
    }
    ws.columns.forEach((c, i) => {
      c.width = Math.min(40, Math.max(10, ...[t.header[i], ...t.rows.map((r) => r[i])].map((v) => (v ?? '').length + 2)))
    })
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }]
  }
  add('Roster', rosterTable(config, roster), 0)
  if (config.members.some((m) => m.type === 'student')) add('Per student', studentSummaryTable(config, roster))
  if (config.rosterMode === 'generate') add('By person', personTable(config, responses, roster))
  const buf = await wb.xlsx.writeBuffer()
  await download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileBase(config)}.xlsx`)
}

export async function exportPng(el: HTMLElement, config: SessionConfig) {
  const { toPng } = await import('html-to-image')
  const bg = getComputedStyle(document.body).backgroundColor
  const url = await toPng(el, { pixelRatio: 2, backgroundColor: bg, width: el.scrollWidth, height: el.scrollHeight })
  await download(await (await fetch(url)).blob(), `${fileBase(config)}.png`)
}

// ---------- Google ----------

/** Upload the roster to the user's Drive as a Google Sheet and return its URL. */
export async function exportToDrive(config: SessionConfig, roster: Roster): Promise<string> {
  const accessToken = await googleToken('https://www.googleapis.com/auth/drive.file')
  const boundary = `wayneday${Date.now()}`
  const meta = { name: `${config.title} ${config.startDate}`, mimeType: 'application/vnd.google-apps.spreadsheet' }
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/csv; charset=UTF-8\r\n\r\n${toCsv(rosterTable(config, roster))}\r\n--${boundary}--`
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (!res.ok) throw new Error(`Drive upload failed (${res.status})`)
  const { id } = (await res.json()) as { id: string }
  return `https://docs.google.com/spreadsheets/d/${id}`
}

// ---------- calendars ----------

/** Google Calendar's event colours (colorId 1–11). */
export const GOOGLE_COLORS = [
  { id: '1', name: 'Lavender', hex: '#7986cb' },
  { id: '2', name: 'Sage', hex: '#33b679' },
  { id: '3', name: 'Grape', hex: '#8e24aa' },
  { id: '4', name: 'Flamingo', hex: '#e67c73' },
  { id: '5', name: 'Banana', hex: '#f6bf26' },
  { id: '6', name: 'Tangerine', hex: '#f4511e' },
  { id: '7', name: 'Peacock', hex: '#039be5' },
  { id: '8', name: 'Graphite', hex: '#616161' },
  { id: '9', name: 'Blueberry', hex: '#3f51b5' },
  { id: '10', name: 'Basil', hex: '#0b8043' },
  { id: '11', name: 'Tomato', hex: '#d50000' },
]

export interface CalEvent {
  title: string
  start: string // YYYY-MM-DDTHH:MM (local time)
  end: string
  description: string
}

/**
 * One event per shift for the chosen people. Title template tokens: {shift} {job} {name} {roster} {role}.
 * Shifts ending at or before their start time finish the next day.
 */
export function buildEvents(config: SessionConfig, roster: Roster, memberIds: string[] | 'all', template: string): CalEvent[] {
  const want = (id: string) => memberIds === 'all' || memberIds.includes(id)
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  const events: CalEvent[] = []
  const make = (date: string, shiftId: string, memberId: string, job: string, role: string) => {
    const shift = config.shifts.find((s) => s.id === shiftId)
    if (!shift) return
    const endDate = addDays(date, endDays(shift))
    const others = [
      ...roster.assignments.filter((a) => a.date === date && a.shiftId === shiftId && a.memberId !== memberId).map((a) => name(a.memberId)),
      ...roster.students.filter((s) => s.date === date && s.shiftId === shiftId && s.memberId !== memberId).map((s) => `${name(s.memberId)} (student)`),
    ]
    events.push({
      title: template
        .replaceAll('{shift}', shift.name)
        .replaceAll('{job}', job)
        .replaceAll('{name}', name(memberId))
        .replaceAll('{roster}', config.title)
        .replaceAll('{role}', role)
        .trim(),
      start: `${date}T${shift.start}`,
      end: `${endDate}T${shift.end}`,
      description: `${config.title}${others.length ? `\nWith: ${others.join(', ')}` : ''}`,
    })
  }
  for (const a of roster.assignments) {
    if (!want(a.memberId)) continue
    const shift = config.shifts.find((s) => s.id === a.shiftId)
    const req = shift?.requirements.find((r) => r.id === a.requirementId)
    make(a.date, a.shiftId, a.memberId, config.jobs.find((j) => j.id === req?.jobId)?.name ?? a.requirementId, 'duty')
  }
  for (const s of roster.students) {
    if (!want(s.memberId)) continue
    const req = config.shifts.find((x) => x.id === s.shiftId)?.requirements.find((r) => r.id === s.requirementId)
    make(s.date, s.shiftId, s.memberId, s.requirementId ? (config.jobs.find((j) => j.id === req?.jobId)?.name ?? 'student') : 'student', 'student')
  }
  for (const p of roster.presenters) {
    if (!want(p.memberId)) continue
    const rule = config.presentations.find((r) => r.id === p.ruleId)
    events.push({
      title: `${rule?.name ?? 'Presentation'}${memberIds === 'all' || memberIds.length > 1 ? ` – ${name(p.memberId)}` : ''}`,
      start: `${p.date}T07:30`,
      end: `${p.date}T08:30`,
      description: `${config.title}${p.postCall ? '\nPresenting after last night’s shift' : ''} (time is a placeholder — adjust in your calendar)`,
    })
  }
  return events.sort((a, b) => a.start.localeCompare(b.start))
}

const icsDate = (local: string) => local.replace(/[-:]/g, '') + '00'
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`)

export async function exportIcs(config: SessionConfig, events: CalEvent[], calendarName: string) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Wayneday//Roster//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsText(calendarName)}`,
    ...events.flatMap((e, i) => [
      'BEGIN:VEVENT',
      `UID:${config.startDate}-${i}-${icsDate(e.start)}@wayneday`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(e.start)}`,
      `DTEND:${icsDate(e.end)}`,
      `SUMMARY:${icsText(e.title)}`,
      `DESCRIPTION:${icsText(e.description)}`,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ]
  await download(new Blob([lines.join('\r\n')], { type: 'text/calendar' }), `${fileBase(config)}.ics`)
}

/** Google Calendar's CSV import format (Settings → Import), for places where .ics files can't be saved. */
export async function exportGoogleCalendarCsv(config: SessionConfig, events: CalEvent[]) {
  const us = (local: string) => {
    const [d, t] = local.split('T')
    const [y, m, day] = d.split('-')
    const [hh, mm] = t.split(':').map(Number)
    return { date: `${m}/${day}/${y}`, time: `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}` }
  }
  const header = ['Subject', 'Start Date', 'Start Time', 'End Date', 'End Time', 'All Day Event', 'Description', 'Private']
  const rows = events.map((e) => {
    const s = us(e.start)
    const f = us(e.end)
    return [e.title, s.date, s.time, f.date, f.time, 'False', e.description, 'True']
  })
  await download(new Blob([toCsv({ header, rows })], { type: 'text/csv' }), `${fileBase(config)}-calendar.csv`)
}

const CAL_SCOPE =
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.app.created'

export interface GoogleCalendar {
  id: string
  summary: string
  primary?: boolean
}

export async function listGoogleCalendars(): Promise<GoogleCalendar[]> {
  const t = await googleToken(CAL_SCOPE)
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer', {
    headers: { Authorization: `Bearer ${t}` },
  })
  if (!res.ok) throw new Error(`Couldn’t list your calendars (${res.status})`)
  const data = (await res.json()) as { items: GoogleCalendar[] }
  return data.items.sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
}

/** Add events to an existing calendar, or to a new one named `newName`. Returns how many were added. */
export async function addToGoogleCalendar(
  events: CalEvent[],
  target: { calendarId: string } | { newName: string },
  colorId: string,
  onProgress?: (done: number) => void,
): Promise<number> {
  const t = await googleToken(CAL_SCOPE)
  const headers = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  let calendarId = 'calendarId' in target ? target.calendarId : ''
  if ('newName' in target) {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
      method: 'POST',
      headers,
      body: JSON.stringify({ summary: target.newName, timeZone }),
    })
    if (!res.ok) throw new Error(`Couldn’t create the calendar (${res.status})`)
    calendarId = ((await res.json()) as { id: string }).id
  }
  let done = 0
  for (const e of events) {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        summary: e.title,
        description: e.description,
        colorId,
        start: { dateTime: `${e.start}:00`, timeZone },
        end: { dateTime: `${e.end}:00`, timeZone },
      }),
    })
    if (!res.ok) throw new Error(`Stopped after ${done} events: Google said ${res.status}`)
    onProgress?.(++done)
  }
  return done
}
