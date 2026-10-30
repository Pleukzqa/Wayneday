// Roster exports: CSV, Excel, PNG and Google Sheets (Drive).
import { dateRange, shortDate, weekday } from './shared/dates.ts'
import { buildProblem, statsFor } from './shared/solver.ts'
import type { Assignment, MemberResponse, SessionConfig } from './shared/types.ts'

export interface Column {
  shiftId: string
  requirementId: string
  title: string
}

export function columnsFor(config: SessionConfig): Column[] {
  const job = (id: string) => config.jobs.find((j) => j.id === id)?.name ?? ''
  return config.shifts.flatMap((s) =>
    s.requirements.map((r) => ({
      shiftId: s.id,
      requirementId: r.id,
      title:
        s.requirements.length === 1 && config.jobs.length <= 1
          ? `${s.name} (${s.start}–${s.end})`
          : `${s.name} · ${job(r.jobId)}${r.memberType === 'any' ? '' : ` (${r.memberType})`}`,
    })),
  )
}

/** Date rows × position columns, names joined in each cell. */
export function rosterTable(config: SessionConfig, assignments: Assignment[]) {
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  const cols = columnsFor(config)
  const header = ['Date', 'Day', ...cols.map((c) => c.title)]
  const rows = dateRange(config.startDate, config.endDate).map((date) => {
    const wd = weekday(date)
    return [
      date,
      shortDate(date).split(' ')[0],
      ...cols.map((c) => {
        const shift = config.shifts.find((s) => s.id === c.shiftId)
        if (!shift?.days.includes(wd)) return '—'
        return assignments
          .filter((a) => a.date === date && a.shiftId === c.shiftId && a.requirementId === c.requirementId)
          .map((a) => name(a.memberId))
          .join(', ')
      }),
    ]
  })
  return { header, rows }
}

export function personTable(config: SessionConfig, responses: Record<string, MemberResponse>, assignments: Assignment[]) {
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
  const header = ['Name', 'Type', 'Total', 'Weekend/holiday', ...config.shifts.map((s) => s.name), 'Dates']
  const rows = config.members.map((m, i) => [
    m.name,
    m.type,
    String(stats[i].total),
    String(stats[i].weekend),
    ...config.shifts.map((s) => String(stats[i].byShift[s.id] ?? 0)),
    assignments
      .filter((a) => a.memberId === m.id)
      .map((a) => a.date)
      .sort()
      .join(' '),
  ])
  return { header, rows }
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
export const toCsv = (t: { header: string[]; rows: string[][] }) =>
  [t.header, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\r\n')

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const fileBase = (config: SessionConfig) =>
  `${config.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'roster'}-${config.startDate}`

export function exportCsv(config: SessionConfig, assignments: Assignment[]) {
  // BOM so Excel reads Thai names correctly.
  download(new Blob(['﻿' + toCsv(rosterTable(config, assignments))], { type: 'text/csv;charset=utf-8' }), `${fileBase(config)}.csv`)
}

export async function exportXlsx(config: SessionConfig, responses: Record<string, MemberResponse>, assignments: Assignment[]) {
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
  add('Roster', rosterTable(config, assignments), 0)
  add('By person', personTable(config, responses, assignments))
  const buf = await wb.xlsx.writeBuffer()
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileBase(config)}.xlsx`)
}

export async function exportPng(el: HTMLElement, config: SessionConfig) {
  const { toPng } = await import('html-to-image')
  const bg = getComputedStyle(document.body).backgroundColor
  const url = await toPng(el, { pixelRatio: 2, backgroundColor: bg, width: el.scrollWidth, height: el.scrollHeight })
  const a = document.createElement('a')
  a.href = url
  a.download = `${fileBase(config)}.png`
  a.click()
}

// ---------- Google Drive ----------

export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? ''

interface TokenClient {
  requestAccessToken(): void
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(o: {
            client_id: string
            scope: string
            callback: (r: { access_token?: string; error?: string }) => void
          }): TokenClient
        }
      }
    }
  }
}

function loadGis(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Could not load Google sign-in'))
    document.head.appendChild(s)
  })
}

/** Upload the roster to the user's Drive as a Google Sheet and return its URL. */
export async function exportToDrive(config: SessionConfig, assignments: Assignment[]): Promise<string> {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google Drive export needs VITE_GOOGLE_CLIENT_ID (see README).')
  await loadGis()
  const accessToken = await new Promise<string>((resolve, reject) => {
    window.google!.accounts.oauth2
      .initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: (r) => (r.access_token ? resolve(r.access_token) : reject(new Error(r.error ?? 'Google sign-in cancelled'))),
      })
      .requestAccessToken()
  })
  const boundary = `wayneday${Date.now()}`
  const meta = { name: `${config.title} ${config.startDate}`, mimeType: 'application/vnd.google-apps.spreadsheet' }
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/csv; charset=UTF-8\r\n\r\n${toCsv(rosterTable(config, assignments))}\r\n--${boundary}--`
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (!res.ok) throw new Error(`Drive upload failed (${res.status})`)
  const { id } = (await res.json()) as { id: string }
  return `https://docs.google.com/spreadsheets/d/${id}`
}
