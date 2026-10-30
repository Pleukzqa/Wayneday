// Setup sections: date exceptions calendar, students, presentation rules, join requests.
import { useState } from 'react'
import { api } from '../api.ts'
import { overrideFor, presentationOn, reqCount, shiftRuns } from '../shared/calendar.ts'
import { dateRange, shortDate, weekday, WEEKDAYS } from '../shared/dates.ts'
import type { Assignment, DateOverride, MemberType, PresentationOverride, PresentationRule, SessionConfig } from '../shared/types.ts'
import { uid, type SessionProps } from './props.ts'

type Edit = (fn: (c: SessionConfig) => SessionConfig) => void

// ---------- calendar of date exceptions ----------

function setOverride(c: SessionConfig, date: string, shiftId: string, patch: Partial<DateOverride>): SessionConfig {
  const shift = c.shifts.find((s) => s.id === shiftId)!
  const current = overrideFor(c, date, shiftId) ?? { date, shiftId, active: shift.days.includes(weekday(date)) }
  const next: DateOverride = { ...current, ...patch }
  // Drop counts equal to the weekly value, and the whole override when it matches the weekly pattern.
  const counts = Object.fromEntries(
    Object.entries(next.counts ?? {}).filter(([rid, n]) => shift.requirements.find((r) => r.id === rid)?.count !== n),
  )
  const clean: DateOverride = { date, shiftId, active: next.active, ...(Object.keys(counts).length ? { counts } : {}) }
  const isDefault = clean.active === shift.days.includes(weekday(date)) && !clean.counts
  const rest = c.overrides.filter((o) => !(o.date === date && o.shiftId === shiftId))
  return { ...c, overrides: isDefault ? rest : [...rest, clean] }
}

function setPresentation(c: SessionConfig, date: string, ruleId: string, patch: Partial<PresentationOverride>): SessionConfig {
  const rule = c.presentations.find((r) => r.id === ruleId)!
  const current = c.presentationOverrides.find((o) => o.date === date && o.ruleId === ruleId) ?? { date, ruleId, active: rule.days.includes(weekday(date)) }
  const next = { ...current, ...patch }
  const clean: PresentationOverride = {
    date,
    ruleId,
    active: next.active,
    ...(next.count !== undefined && next.count !== rule.count ? { count: next.count } : {}),
    ...(next.fromCount !== undefined && next.fromCount !== rule.fromCount ? { fromCount: next.fromCount } : {}),
  }
  const isDefault = clean.active === rule.days.includes(weekday(date)) && clean.count === undefined && clean.fromCount === undefined
  const rest = c.presentationOverrides.filter((o) => !(o.date === date && o.ruleId === ruleId))
  return { ...c, presentationOverrides: isDefault ? rest : [...rest, clean] }
}

/**
 * Copy one day's shifts and presentations to other dates — only where that shift or presentation normally
 * happens or is already on, so copying a Monday change across the week leaves the weekend alone.
 */
function copyDay(c: SessionConfig, from: string, targets: string[]): SessionConfig {
  let next = c
  for (const t of targets) {
    for (const s of c.shifts) {
      if (!s.days.includes(weekday(t)) && !shiftRuns(c, s, t)) continue
      const runs = shiftRuns(c, s, from)
      const counts = Object.fromEntries(s.requirements.map((r) => [r.id, reqCount(c, s, r, from) || r.count]))
      next = setOverride(next, t, s.id, { active: runs, counts })
    }
    for (const r of c.presentations) {
      if (!r.days.includes(weekday(t)) && !presentationOn(c, r, t)) continue
      const p = presentationOn(c, r, from)
      next = setPresentation(next, t, r.id, p ? { active: true, count: p.count, fromCount: p.fromCount } : { active: false })
    }
  }
  return next
}

export function CalendarCard({ draft, edit, ro }: { draft: SessionConfig; edit: Edit; ro: boolean }) {
  const [selected, setSelected] = useState<string | null>(null)
  const days = dateRange(draft.startDate, draft.endDate)
  if (days.length === 0 || draft.shifts.length === 0) return null
  const lead = weekday(days[0])
  const job = (id: string) => draft.jobs.find((j) => j.id === id)?.name ?? ''
  const changed = (date: string) => draft.overrides.some((o) => o.date === date) || draft.presentationOverrides.some((o) => o.date === date)
  const weekOf = (date: string) => days.filter((d) => Math.floor((dayIndex(d) + lead) / 7) === Math.floor((dayIndex(date) + lead) / 7))
  const dayIndex = (d: string) => days.indexOf(d)
  const sameWeekday = (date: string) => days.filter((d) => weekday(d) === weekday(date))
  const resetDates = (dates: string[]) =>
    edit((c) => ({
      ...c,
      overrides: c.overrides.filter((o) => !dates.includes(o.date)),
      presentationOverrides: c.presentationOverrides.filter((o) => !dates.includes(o.date)),
    }))

  return (
    <section className="card">
      <h2>Calendar</h2>
      <p className="muted small">
        Shifts and presentations follow their weekly pattern. Tap a date to change that day: switch a shift or presentation off or on, or change
        how many people or presentations it needs. Then copy the change to the rest of that week or to every same weekday. Changed dates are
        marked.
      </p>
      <div className="cal" role="grid" aria-label="Dates in this roster">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-head" role="columnheader">
            {w}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`pad${i}`} />
        ))}
        {days.map((date) => {
          const running = draft.shifts.filter((s) => shiftRuns(draft, s, date))
          const talks = draft.presentations.reduce((n, r) => n + (presentationOn(draft, r, date)?.count ?? 0), 0)
          return (
            <button
              key={date}
              type="button"
              role="gridcell"
              aria-pressed={selected === date}
              className={`cal-day ${selected === date ? 'on' : ''} ${changed(date) ? 'changed' : ''} ${draft.holidays.includes(date) ? 'holiday' : ''}`}
              onClick={() => setSelected(selected === date ? null : date)}
            >
              <span className="cal-num">{Number(date.slice(8))}</span>
              <span className="cal-shifts">{running.length ? running.map((s) => s.name.slice(0, 1)).join('') : '—'}</span>
              {draft.presentations.length > 0 && <span className="cal-talks">{talks ? `P${talks}` : ' '}</span>}
            </button>
          )
        })}
      </div>
      {selected && (
        <div className="cal-editor">
          <div className="row between wrap">
            <strong>{shortDate(selected)}</strong>
            {!ro && changed(selected) && (
              <button type="button" className="link" onClick={() => resetDates([selected])}>
                Reset this day
              </button>
            )}
          </div>
          {draft.shifts.map((s) => {
            const runs = shiftRuns(draft, s, selected)
            return (
              <div key={s.id} className="cal-shift">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={runs}
                    disabled={ro}
                    onChange={(e) => edit((c) => setOverride(c, selected, s.id, { active: e.target.checked }))}
                  />
                  <strong>{s.name}</strong>
                  <span className="muted small">
                    {s.start}–{s.end}
                  </span>
                </label>
                {runs &&
                  s.requirements.map((r) => (
                    <label key={r.id} className="inline small">
                      {job(r.jobId)} ({r.memberType === 'any' ? 'anyone' : r.memberType})
                      <input
                        type="number"
                        min={0}
                        max={20}
                        disabled={ro}
                        value={reqCount(draft, s, r, selected)}
                        onChange={(e) =>
                          edit((c) => {
                            const o = overrideFor(c, selected, s.id)
                            return setOverride(c, selected, s.id, { counts: { ...o?.counts, [r.id]: Math.max(0, Number(e.target.value) || 0) } })
                          })
                        }
                      />
                    </label>
                  ))}
              </div>
            )
          })}
          {draft.presentations.map((r) => {
            const p = presentationOn(draft, r, selected)
            const from = draft.shifts.find((s) => s.id === r.fromShiftId)?.name ?? 'shift'
            return (
              <div key={r.id} className="cal-shift">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Boolean(p)}
                    disabled={ro}
                    onChange={(e) => edit((c) => setPresentation(c, selected, r.id, { active: e.target.checked }))}
                  />
                  <strong>{r.name}</strong>
                </label>
                {p && (
                  <>
                    <label className="inline small">
                      presentations
                      <input
                        type="number"
                        min={1}
                        max={20}
                        disabled={ro}
                        value={p.count}
                        onChange={(e) => {
                          const count = Math.max(1, Number(e.target.value) || 1)
                          edit((c) => setPresentation(c, selected, r.id, { count, fromCount: Math.min(p.fromCount, count) }))
                        }}
                      />
                    </label>
                    <label className="inline small">
                      from last {from}
                      <input
                        type="number"
                        min={0}
                        max={p.count}
                        disabled={ro}
                        value={p.fromCount}
                        onChange={(e) => edit((c) => setPresentation(c, selected, r.id, { fromCount: Math.min(p.count, Math.max(0, Number(e.target.value) || 0)) }))}
                      />
                    </label>
                  </>
                )}
              </div>
            )
          })}
          {!ro && (
            <div className="row wrap cal-copy">
              <span className="small muted">Copy this day to:</span>
              <button type="button" onClick={() => edit((c) => copyDay(c, selected, weekOf(selected).filter((d) => d !== selected)))}>
                Rest of this week
              </button>
              <button type="button" onClick={() => edit((c) => copyDay(c, selected, sameWeekday(selected).filter((d) => d !== selected)))}>
                Every {WEEKDAYS[weekday(selected)]}
              </button>
              <button type="button" className="link" onClick={() => resetDates(weekOf(selected))}>
                Reset this week
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ---------- students ----------

export function StudentsCard({ draft, edit, ro }: { draft: SessionConfig; edit: Edit; ro: boolean }) {
  const st = draft.students
  const count = draft.members.filter((m) => m.type === 'student').length
  const set = (patch: Partial<SessionConfig['students']>) => edit((c) => ({ ...c, students: { ...c.students, ...patch } }))
  return (
    <section className="card">
      <h2>Students</h2>
      <p className="muted small">
        Students don’t fill positions. After residents and staff are scheduled, Wayneday places students on these shifts so every resident
        and every staff member is on duty with students about equally often. {count ? `${count} student(s) in People.` : 'Add people as “Student” to use this.'}
      </p>
      <div className="row wrap">
        <span className="small">Students join:</span>
        {draft.shifts.map((s) => (
          <label key={s.id} className="check">
            <input
              type="checkbox"
              disabled={ro}
              checked={st.shiftIds.includes(s.id)}
              onChange={(e) => set({ shiftIds: e.target.checked ? [...st.shiftIds, s.id] : st.shiftIds.filter((x) => x !== s.id) })}
            />
            {s.name}
          </label>
        ))}
      </div>
      <div className="row wrap">
        <label className="inline">
          Each student does
          <input type="number" min={0} max={100} disabled={ro} value={st.shiftsPerStudent} onChange={(e) => set({ shiftsPerStudent: Math.max(0, Number(e.target.value) || 0) })} />
          shifts
        </label>
        <label className="inline">
          At most
          <input type="number" min={1} max={20} disabled={ro} value={st.maxPerShift} onChange={(e) => set({ maxPerShift: Math.max(1, Number(e.target.value) || 1) })} />
          student(s) per shift
        </label>
      </div>
    </section>
  )
}

// ---------- presentations ----------

const TYPES: MemberType[] = ['resident', 'staff', 'student']

export function PresentationsCard({ draft, edit, ro }: { draft: SessionConfig; edit: Edit; ro: boolean }) {
  const set = (id: string, patch: Partial<PresentationRule>) =>
    edit((c) => ({ ...c, presentations: c.presentations.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  return (
    <section className="card">
      <h2>Presentations</h2>
      <p className="muted small">
        E.g. morning report: on weekdays, 2 cases are presented and at least 1 presenter must be someone coming off last night’s shift.
        Wayneday picks presenters and shares the load evenly.
      </p>
      {draft.presentations.map((p) => (
        <div key={p.id} className="shift">
          <div className="row wrap">
            <label>
              Name
              <input value={p.name} disabled={ro} onChange={(e) => set(p.id, { name: e.target.value })} />
            </label>
            <div className="weekdays" role="group" aria-label="Days">
              {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                <button
                  type="button"
                  key={d}
                  disabled={ro}
                  aria-pressed={p.days.includes(d)}
                  className={p.days.includes(d) ? 'day on' : 'day'}
                  onClick={() => set(p.id, { days: p.days.includes(d) ? p.days.filter((x) => x !== d) : [...p.days, d].sort() })}
                >
                  {WEEKDAYS[d][0]}
                </button>
              ))}
            </div>
            {!ro && (
              <button type="button" className="link danger" onClick={() => edit((c) => ({ ...c, presentations: c.presentations.filter((x) => x.id !== p.id) }))}>
                Remove
              </button>
            )}
          </div>
          <div className="row wrap">
            <label className="inline">
              <input type="number" min={1} max={20} disabled={ro} value={p.count} onChange={(e) => {
                const count = Math.max(1, Number(e.target.value) || 1)
                set(p.id, { count, fromCount: Math.min(p.fromCount, count) })
              }} />
              presentation(s), at least
              <input type="number" min={0} max={p.count} disabled={ro} value={p.fromCount} onChange={(e) => set(p.id, { fromCount: Math.min(p.count, Math.max(0, Number(e.target.value) || 0)) })} />
              by people on
              <select value={p.fromShiftId} disabled={ro} onChange={(e) => set(p.id, { fromShiftId: e.target.value })}>
                {draft.shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              the day before
            </label>
          </div>
          <div className="row wrap">
            <span className="small">Who can present:</span>
            {TYPES.map((t) => (
              <label key={t} className="check">
                <input
                  type="checkbox"
                  disabled={ro}
                  checked={p.types.includes(t)}
                  onChange={(e) => set(p.id, { types: e.target.checked ? [...p.types, t] : p.types.filter((x) => x !== t) })}
                />
                {t}
              </label>
            ))}
          </div>
        </div>
      ))}
      {!ro && draft.shifts.length > 0 && (
        <button
          type="button"
          onClick={() =>
            edit((c) => ({
              ...c,
              presentations: [
                ...c.presentations,
                { id: uid(), name: 'Morning report', days: [1, 2, 3, 4, 5], count: 2, fromShiftId: c.shifts[0].id, fromCount: 1, types: ['resident'] },
              ],
            }))
          }
        >
          + Presentation rule
        </button>
      )}
    </section>
  )
}

// ---------- join requests ----------

export function JoinRequests({ code, session, mutate, dirty }: SessionProps & { dirty: boolean }) {
  const pending = session.joinRequests.filter((r) => r.status === 'pending')
  const [link, setLink] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  if (pending.length === 0) return null
  return (
    <div className="joins">
      <strong>Waiting to join ({pending.length})</strong>
      {dirty && <p className="small warn-text">Save your setup changes first, then approve.</p>}
      {pending.map((r) => (
        <div key={r.id} className="row wrap join-row">
          <span>
            <strong>{r.name}</strong> <span className="muted small">{r.type}</span>
          </span>
          <select value={link[r.id] ?? ''} onChange={(e) => setLink({ ...link, [r.id]: e.target.value })} aria-label={`Who is ${r.name}?`}>
            <option value="">Add as a new person</option>
            {session.config.members.map((m) => (
              <option key={m.id} value={m.id}>
                This is {m.name}
                {session.claimed.includes(m.id) ? ' (replaces their PIN)' : ''}
              </option>
            ))}
          </select>
          <button
            className="primary"
            disabled={dirty}
            onClick={async () => {
              setError(null)
              try {
                await mutate(() => api.decideJoin(code, r.id, true, link[r.id] || undefined))
              } catch (e) {
                setError((e as Error).message)
              }
            }}
          >
            Approve
          </button>
          <button disabled={dirty} onClick={() => void mutate(() => api.decideJoin(code, r.id, false))}>
            Reject
          </button>
        </div>
      ))}
      {error && <span className="error small">{error}</span>}
    </div>
  )
}

// ---------- who makes the resident/staff roster ----------

export function RosterModeCard({ draft, edit, ro }: { draft: SessionConfig; edit: Edit; ro: boolean }) {
  return (
    <section className="card">
      <h2>Residents &amp; staff roster</h2>
      <div className="segmented wrap-seg" role="radiogroup" aria-label="Who makes the resident and staff roster">
        {(
          [
            ['hospital', 'From the hospital', 'You enter who is on duty each date; Wayneday arranges only the students.'],
            ['generate', 'Made by Wayneday', 'Wayneday also schedules residents and staff from their availability.'],
          ] as const
        ).map(([v, label, hint]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={draft.rosterMode === v}
            disabled={ro}
            title={hint}
            className={draft.rosterMode === v ? 'on' : ''}
            onClick={() => edit((c) => ({ ...c, rosterMode: v }))}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">
        {draft.rosterMode === 'hospital'
          ? 'You enter (or paste) who the hospital put on duty each date, below. Wayneday arranges only the students and presenters.'
          : 'Wayneday schedules residents and staff from their availability and preferences, then arranges the students.'}
      </p>
    </section>
  )
}

// ---------- the hospital's roster (hospital mode) ----------

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** Parse a pasted table (from Excel / Google Sheets / CSV) into duty assignments and new names. */
function parseDutyPaste(text: string, draft: SessionConfig) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const delim = lines.some((l) => l.includes('\t')) ? '\t' : ','
  const rows = lines.map((l) => l.split(delim).map((c) => c.replace(/^"|"$/g, '').trim()))
  const positions = draft.shifts.flatMap((s) => s.requirements.map((r) => ({ shift: s, req: r })))
  const titles = positions.map(({ shift, req }) => norm(`${shift.name} · ${draft.jobs.find((j) => j.id === req.jobId)?.name ?? ''}`))
  const days = dateRange(draft.startDate, draft.endDate)
  const toDate = (v: string): string | null => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return days.includes(v) ? v : null
    const m = /^(\d{1,2})(?:[/.-](\d{1,2}))?(?:[/.-](\d{2,4}))?$/.exec(v)
    if (!m) return null
    const day = Number(m[1])
    const month = m[2] ? Number(m[2]) : null
    return days.find((d) => Number(d.slice(8)) === day && (month === null || Number(d.slice(5, 7)) === month)) ?? null
  }
  // Header row → match columns by title; otherwise Date, [Day], then positions in order.
  let colMap: (number | null)[] = []
  let body = rows
  if (rows.length && !toDate(rows[0][0])) {
    const header = rows[0].map(norm)
    colMap = header.map((h) => {
      const i = titles.findIndex((t) => h.startsWith(t) || t.startsWith(h.replace(/\s*\(.*\)$/, '')))
      return i >= 0 ? i : null
    })
    body = rows.slice(1)
  }
  const duty: Assignment[] = []
  const newPeople = new Map<string, { name: string; type: 'resident' | 'staff' }>()
  const members = [...draft.members]
  let readDays = 0
  for (const r of body) {
    const date = toDate(r[0] ?? '')
    if (!date) continue
    readDays++
    const cells = colMap.length ? r : r.slice(1).filter((_, k) => !(k === 0 && /^[a-z]{2,3}$/i.test(r[1] ?? '')))
    cells.forEach((cell, k) => {
      const pi = colMap.length ? colMap[k] : k
      if (pi === null || pi === undefined || !positions[pi] || !cell || cell === '—') return
      const { shift, req } = positions[pi]
      for (const raw of cell.split(/[,/+&]| and /)) {
        const name = raw.trim()
        if (!name) continue
        let m = members.find((x) => norm(x.name) === norm(name))
        if (!m) {
          const type = req.memberType === 'staff' ? 'staff' : 'resident'
          m = { id: uid(), name, type, jobs: [] }
          members.push(m)
          newPeople.set(m.id, { name, type })
        }
        duty.push({ date, shiftId: shift.id, requirementId: req.id, memberId: m.id })
      }
    })
  }
  return { duty, members, newPeople: [...newPeople.values()], readDays }
}

export function DutyRosterCard({ draft, edit, ro }: { draft: SessionConfig; edit: Edit; ro: boolean }) {
  const [paste, setPaste] = useState('')
  const [parsed, setParsed] = useState<ReturnType<typeof parseDutyPaste> | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const days = dateRange(draft.startDate, draft.endDate)
  const positions = draft.shifts.flatMap((s) => s.requirements.map((r) => ({ shift: s, req: r })))
  const job = (id: string) => draft.jobs.find((j) => j.id === id)?.name ?? ''
  const title = (p: (typeof positions)[number]) => `${p.shift.name} · ${job(p.req.jobId)}`
  const filled = draft.duty.length
  const needed = days.reduce((n, d) => n + positions.reduce((k, p) => k + reqCount(draft, p.shift, p.req, d), 0), 0)

  const setCell = (date: string, shiftId: string, reqId: string, slot: number, memberId: string) =>
    edit((c) => {
      const here = c.duty.filter((a) => a.date === date && a.shiftId === shiftId && a.requirementId === reqId)
      const rest = c.duty.filter((a) => a !== here[slot])
      return { ...c, duty: memberId ? [...rest, { date, shiftId, requirementId: reqId, memberId }] : rest }
    })

  const template = ['Date\tDay\t' + positions.map(title).join('\t'), ...days.map((d) => `${d}\t${shortDate(d).split(' ')[0]}${'\t'.repeat(positions.length)}`)].join('\n')

  return (
    <section className="card">
      <h2>
        Hospital roster <span className="badge">{filled}/{needed} filled</span>
      </h2>
      <p className="muted small">
        Who is on duty each date. Pick names below, or paste the hospital’s table from Excel or Google Sheets (first column = date; one
        column per position, in the order shown). Several people in one cell can be separated with commas. New names are added to People.
      </p>
      {!ro && (
        <>
          <div className="row wrap">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(template)
                  setMsg('Empty table copied — paste it into a spreadsheet, fill it in, then copy it back here.')
                } catch {
                  setMsg('Couldn’t copy. Type the table in a spreadsheet with these columns: Date, Day, ' + positions.map(title).join(', '))
                }
              }}
            >
              Copy empty table
            </button>
            {filled > 0 && (
              <button type="button" className="link danger" onClick={() => edit((c) => ({ ...c, duty: [] }))}>
                Clear roster
              </button>
            )}
          </div>
          <label>
            Paste from a spreadsheet
            <textarea
              rows={3}
              value={paste}
              placeholder={'1/11\tAnn\tBank\tDr. Somchai\n2/11\tPloy\tMint\tDr. Wipa'}
              onChange={(e) => {
                setPaste(e.target.value)
                setParsed(e.target.value.trim() ? parseDutyPaste(e.target.value, draft) : null)
              }}
            />
          </label>
          {parsed && (
            <div className="row wrap">
              <span className="small">
                Read {parsed.readDays} day(s), {parsed.duty.length} shift(s).
                {parsed.newPeople.length > 0 && ` New people: ${parsed.newPeople.map((p) => `${p.name} (${p.type})`).join(', ')}.`}
              </span>
              <button
                type="button"
                className="primary"
                disabled={parsed.duty.length === 0}
                onClick={() => {
                  const dates = new Set(parsed.duty.map((a) => a.date))
                  edit((c) => ({ ...c, members: parsed.members, duty: [...c.duty.filter((a) => !dates.has(a.date)), ...parsed.duty] }))
                  setPaste('')
                  setParsed(null)
                  setMsg(`Filled ${dates.size} day(s). Save setup to keep it.`)
                }}
              >
                Use this
              </button>
            </div>
          )}
          {msg && <p className="small">{msg}</p>}
        </>
      )}
      <div className="scroll-x grid-wrap">
        <table className="roster duty">
          <thead>
            <tr>
              <th className="sticky">Date</th>
              {positions.map((p) => (
                <th key={p.req.id}>
                  {title(p)}
                  <div className="muted tiny">{p.req.memberType === 'any' ? 'resident or staff' : p.req.memberType}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((date) => (
              <tr key={date} className={[0, 6].includes(weekday(date)) || draft.holidays.includes(date) ? 'weekend' : ''}>
                <th className="sticky nowrap">{shortDate(date)}</th>
                {positions.map((p) => {
                  const n = reqCount(draft, p.shift, p.req, date)
                  if (n === 0) return <td key={p.req.id} className="off" />
                  const here = draft.duty.filter((a) => a.date === date && a.shiftId === p.shift.id && a.requirementId === p.req.id)
                  const cands = draft.members.filter((m) => m.type !== 'student' && (p.req.memberType === 'any' || m.type === p.req.memberType))
                  return (
                    <td key={p.req.id}>
                      {Array.from({ length: Math.max(n, here.length) }, (_, k) => (
                        <select
                          key={k}
                          className="cell-select"
                          disabled={ro}
                          aria-label={`${shortDate(date)} ${title(p)}`}
                          value={here[k]?.memberId ?? ''}
                          onChange={(e) => setCell(date, p.shift.id, p.req.id, k, e.target.value)}
                        >
                          <option value="">—</option>
                          {cands.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      ))}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
