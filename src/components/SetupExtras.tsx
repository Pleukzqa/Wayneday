// Setup sections: date exceptions calendar, students, presentation rules, join requests.
import { useState } from 'react'
import { api } from '../api.ts'
import { overrideFor, reqCount, shiftRuns } from '../shared/calendar.ts'
import { dateRange, shortDate, weekday, WEEKDAYS } from '../shared/dates.ts'
import type { DateOverride, MemberType, PresentationRule, SessionConfig } from '../shared/types.ts'
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

export function CalendarCard({ draft, edit, ro }: { draft: SessionConfig; edit: Edit; ro: boolean }) {
  const [selected, setSelected] = useState<string | null>(null)
  const days = dateRange(draft.startDate, draft.endDate)
  if (days.length === 0 || draft.shifts.length === 0) return null
  const lead = weekday(days[0])
  const job = (id: string) => draft.jobs.find((j) => j.id === id)?.name ?? ''
  const changed = (date: string) => draft.overrides.some((o) => o.date === date)

  return (
    <section className="card">
      <h2>Calendar</h2>
      <p className="muted small">
        Shifts follow the weekly pattern above. Tap a date to switch a shift off, add one, or change how many people it needs that day
        (e.g. holidays, exam weeks, a short-staffed week). Changed dates are marked.
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
              <span className="cal-shifts">
                {running.length ? running.map((s) => s.name.slice(0, 1)).join('') : '—'}
              </span>
            </button>
          )
        })}
      </div>
      {selected && (
        <div className="cal-editor">
          <div className="row between wrap">
            <strong>{shortDate(selected)}</strong>
            {!ro && changed(selected) && (
              <button type="button" className="link" onClick={() => edit((c) => ({ ...c, overrides: c.overrides.filter((o) => o.date !== selected) }))}>
                Reset to weekly pattern
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
