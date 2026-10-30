// Setup sections: date exceptions calendar, students, presentation rules, join requests.
import { useState } from 'react'
import { api } from '../api.ts'
import { equalShareFor } from '../shared/students.ts'
import { t, typeName, weekdayLetter, weekdayLong, weekdayShort } from '../shared/i18n.ts'
import { overrideFor, presentationOn, reqCount, shiftRuns } from '../shared/calendar.ts'
import { dateRange, shortDate, weekday } from '../shared/dates.ts'
import { ANY_SHIFT, DUTY_ROLES, type DateOverride, type DutyRole, type MemberResponse, type MemberType, type PresentationOverride, type PresentationRule, type SessionConfig } from '../shared/types.ts'
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
  for (const target of targets) {
    for (const s of c.shifts) {
      if (!s.days.includes(weekday(target)) && !shiftRuns(c, s, target)) continue
      const runs = shiftRuns(c, s, from)
      const counts = Object.fromEntries(s.requirements.map((r) => [r.id, reqCount(c, s, r, from) || r.count]))
      next = setOverride(next, target, s.id, { active: runs, counts })
    }
    for (const r of c.presentations) {
      if (!r.days.includes(weekday(target)) && !presentationOn(c, r, target)) continue
      const p = presentationOn(c, r, from)
      next = setPresentation(next, target, r.id, p ? { active: true, count: p.count, fromCount: p.fromCount } : { active: false })
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
      <h2 id="sec-calendar">🗓️ {t('Calendar')}</h2>
      <p className="muted small">{t(
        "Shifts and presentations follow their weekly pattern. Tap a date to change that day: switch a shift or presentation off or on, or change how many people or presentations it needs. Then copy the change to the rest of that week or to every same weekday. Changed dates are marked."
      )}</p>
      <div className="cal" role="grid" aria-label={t("Dates in this roster")}>
        {weekdayShort().map((w, i) => (
          <div key={i} className="cal-head" role="columnheader">
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
      <div className="cal-legend small" aria-label={t("Legend")}>
        {draft.shifts.map((sh) => (
          <span key={sh.id}>
            <b>{sh.name.slice(0, 1)}</b>= {sh.name} {t("shift runs")}</span>
        ))}
        <span>
          <b>—</b> {t("= no shift")}</span>
        {draft.presentations.length > 0 && (
          <span>
            <b className="accent">P2</b> {t("= 2 presentations that morning")}</span>
        )}
        <span>
          <i className="legend-box changed" aria-hidden /> {t("changed from the usual week")}</span>
        {draft.holidays.length > 0 && (
          <span>
            <i className="legend-box holiday" aria-hidden /> {t("holiday")}</span>
        )}
      </div>
      {selected && (
        <div className="cal-editor">
          <div className="row between wrap">
            <strong>{shortDate(selected)}</strong>
            {!ro && changed(selected) && (
              <button type="button" className="link" onClick={() => resetDates([selected])}>{t("Reset this day")}</button>
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
                      {r.jobId ? `${job(r.jobId)} ` : ''}({draft.rosterMode === 'hospital' ? t("students") : r.memberType === 'any' ? t("anyone") : r.memberType})
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
            );
          })}
          {draft.presentations.map((r) => {
            const p = presentationOn(draft, r, selected)
            const from = r.fromShiftId === ANY_SHIFT ? t('any shift') : (draft.shifts.find((s) => s.id === r.fromShiftId)?.name ?? 'shift')
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
                    <label className="inline small">{t("presentations")} <input
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
                    <label className="inline small">{t("from last")} {from}
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
            );
          })}
          {!ro && (
            <div className="row wrap cal-copy">
              <span className="small muted">{t("Copy this day to:")}</span>
              <button type="button" onClick={() => edit((c) => copyDay(c, selected, weekOf(selected).filter((d) => d !== selected)))}>{t("Rest of this week")}</button>
              <button type="button" onClick={() => edit((c) => copyDay(c, selected, sameWeekday(selected).filter((d) => d !== selected)))}>{t('Every {day}', { day: weekdayLong()[weekday(selected)] })}
              </button>
              <button type="button" className="link" onClick={() => resetDates(weekOf(selected))}>{t("Reset this week")}</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- students ----------

export function StudentsCard({ draft, edit, ro, responses }: { draft: SessionConfig; edit: Edit; ro: boolean; responses: Record<string, MemberResponse> }) {
  const st = draft.students
  const count = draft.members.filter((m) => m.type === 'student').length
  const set = (patch: Partial<SessionConfig['students']>) => edit((c) => ({ ...c, students: { ...c.students, ...patch } }))
  if (draft.rosterMode === 'hospital') {
    const slots = draft.shifts.filter((x) => x.requirements.length > 0)
    const auto = Boolean(st.auto)
    const perSlot = !auto && Object.keys(st.perSlot ?? {}).length > 0
    const share = equalShareFor(draft, responses)
    const check = (key: 'avoidRepeatResident' | 'avoidRepeatStaff' | 'avoidRepeatPartner' | 'wantPartner', label: string) => (
      <label className="check">
        <input type="checkbox" disabled={ro} checked={Boolean(st[key])} onChange={(e) => set({ [key]: e.target.checked })} />
        {t(label)}
      </label>
    )
    return (
      <section className="card">
        <h2 id="sec-studentrules">🎯 {t('Student shifts')}</h2>
        <p className="muted small">{t(
            "Wayneday places students in the student places of each shift so every resident and every staff member in the hospital roster is on duty with students about equally often."
          )} {count ? t('{n} student(s).', { n: count }) : t("Add students above.")}
        </p>
        <div className="segmented wrap-seg" role="radiogroup" aria-label={t("How many shifts each student does")}>
          <button type="button" role="radio" aria-checked={auto} className={auto ? 'on' : ''} disabled={ro} onClick={() => set({ auto: true, perSlot: {} })}>
            ⚖️ {t('Share equally')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!auto && !perSlot}
            className={!auto && !perSlot ? 'on' : ''}
            disabled={ro}
            onClick={() => set({ auto: false, perSlot: {} })}
          >
            {t('A total')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={perSlot}
            className={perSlot ? 'on' : ''}
            disabled={ro}
            onClick={() => set({ auto: false, perSlot: Object.fromEntries(slots.map((x) => [x.id, 1])) })}
          >
            {t('A number of each shift')}
          </button>
        </div>
        {auto ? (
          <p className="small share">
            {!count || !share.places
              ? t('Add students and student places, and Wayneday splits the places between them equally.')
              : share.extra
                ? t('{p} student places ÷ {s} students → {k} students do {b} shifts, the rest do {a}.', { p: share.total, s: count, k: share.extra, a: share.base, b: share.base + 1 })
                : t('{p} student places ÷ {s} students → every student does {a} shifts.', { p: share.total, s: count, a: share.base })}{' '}
            {share.limited && (
              <strong className="warn-text">
                {t('Only about {n} of the {p} places can be shared fairly: {name} can fit just {k} shifts around their unavailable dates and gap.', {
                  n: share.total,
                  p: share.places,
                  name: share.limited.name,
                  k: share.limited.k,
                })}{' '}
              </strong>
            )}
            <span className="muted">{t('Every place is filled up to its “at most” number, and everyone gets a similar mix of shift slots. Wayneday picks who takes the extra shifts.')}</span>
          </p>
        ) : perSlot ? (
          <div className="row wrap">
            <span className="small">{t("Each student does exactly")}</span>
            {slots.map((x) => (
              <label key={x.id} className="inline">
                <input
                  type="number"
                  min={0}
                  max={50}
                  disabled={ro}
                  value={st.perSlot?.[x.id] ?? 0}
                  onChange={(e) => set({ perSlot: { ...st.perSlot, [x.id]: Math.max(0, Number(e.target.value) || 0) } })}
                />
                × {x.name}
              </label>
            ))}
          </div>
        ) : (
          <label className="inline">{t("Each student does")} <input type="number" min={0} max={100} disabled={ro} value={st.shiftsPerStudent} onChange={(e) => set({ shiftsPerStudent: Math.max(0, Number(e.target.value) || 0) })} /> {t("shifts")}</label>
        )}
        <label className="inline">{t("A student’s shifts at least")} <input type="number" min={0} max={60} disabled={ro} value={st.minGap ?? 0} onChange={(e) => set({ minGap: Math.max(0, Number(e.target.value) || 0) })} /> {t("days apart")} <span className="muted small">{t("(0 = each student’s own answer)")}</span>
        </label>
        <div className="rules">
          <span className="small">{t("Try to avoid:")}</span>
          {check('avoidRepeatResident', 'the same resident twice for a student')}
          {check('avoidRepeatStaff', 'the same staff (อาจารย์) twice for a student')}
          {check('avoidRepeatPartner', 'the same two students together twice')}
          {check('wantPartner', 'a student being alone on every shift')}
        </div>
        <p className="muted small">{t(
          "These are tried as hard as possible; the Roster tab says if any couldn’t be met."
        )}</p>
      </section>
    );
  }
  return (
    <section className="card">
      <h2 id="sec-studentrules">🎯 {t('Students')}</h2>
      <p className="muted small">{t(
          "Students don’t fill positions. After residents and staff are scheduled, Wayneday places students on these shifts so every resident and every staff member is on duty with students about equally often."
        )} {count ? `${count} student(s) in People.` : t("Add people as “Student” to use this.")}
      </p>
      <div className="row wrap">
        <span className="small">{t("Students join:")}</span>
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
        <label className="inline">{t("Each student does")} <input type="number" min={0} max={100} disabled={ro} value={st.shiftsPerStudent} onChange={(e) => set({ shiftsPerStudent: Math.max(0, Number(e.target.value) || 0) })} /> {t("shifts")}</label>
        <label className="inline">{t("At most")} <input type="number" min={1} max={20} disabled={ro} value={st.maxPerShift} onChange={(e) => set({ maxPerShift: Math.max(1, Number(e.target.value) || 1) })} /> {t("student(s) per shift")}</label>
      </div>
    </section>
  );
}

// ---------- presentations ----------

const TYPES: MemberType[] = ['resident', 'staff', 'student']

export function PresentationsCard({ draft, edit, ro }: { draft: SessionConfig; edit: Edit; ro: boolean }) {
  const set = (id: string, patch: Partial<PresentationRule>) =>
    edit((c) => ({ ...c, presentations: c.presentations.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  return (
    <section className="card">
      <h2 id="sec-presentations">🎤 {t('Presentations')}</h2>
      <p className="muted small">{t(
        "E.g. morning report: on weekdays, 2 cases are presented and at least 1 presenter must be someone coming off last night’s shift. Wayneday picks presenters and shares the load evenly."
      )}</p>
      {draft.presentations.map((p) => (
        <div key={p.id} className="shift">
          <div className="row wrap">
            <label>{t("Name")} <input value={p.name} disabled={ro} onChange={(e) => set(p.id, { name: e.target.value })} />
            </label>
            <div className="weekdays" role="group" aria-label={t("Days")}>
              {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                <button
                  type="button"
                  key={d}
                  disabled={ro}
                  aria-pressed={p.days.includes(d)}
                  className={p.days.includes(d) ? 'day on' : 'day'}
                  onClick={() => set(p.id, { days: p.days.includes(d) ? p.days.filter((x) => x !== d) : [...p.days, d].sort() })}
                >
                  {weekdayLetter()[d]}
                </button>
              ))}
            </div>
            {!ro && (
              <button type="button" className="link danger" onClick={() => edit((c) => ({ ...c, presentations: c.presentations.filter((x) => x.id !== p.id) }))}>{t("Remove")}</button>
            )}
          </div>
          <div className="row wrap">
            <label className="inline">
              <input type="number" min={1} max={20} disabled={ro} value={p.count} onChange={(e) => {
                const count = Math.max(1, Number(e.target.value) || 1)
                set(p.id, { count, fromCount: Math.min(p.fromCount, count) })
              }} /> {t("presentation(s), at least")} <input type="number" min={0} max={p.count} disabled={ro} value={p.fromCount} onChange={(e) => set(p.id, { fromCount: Math.min(p.count, Math.max(0, Number(e.target.value) || 0)) })} /> {t("by people on")} <select value={p.fromShiftId} disabled={ro} onChange={(e) => set(p.id, { fromShiftId: e.target.value })}>
                <option value={ANY_SHIFT}>{t('any shift')}</option>
                {draft.shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select> {t("the day before")}</label>
          </div>
          {draft.rosterMode !== 'hospital' && (
            <div className="row wrap">
              <span className="small">{t("Who can present:")}</span>
              {TYPES.map((ty) => (
                <label key={ty} className="check">
                  <input
                    type="checkbox"
                    disabled={ro}
                    checked={p.types.includes(ty)}
                    onChange={(e) => set(p.id, { types: e.target.checked ? [...p.types, ty] : p.types.filter((x) => x !== ty) })}
                  />
                  {typeName(ty)}
                </label>
              ))}
            </div>
          )}
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
                { id: uid(), name: 'Morning report', days: [1, 2, 3, 4, 5], count: 2, fromShiftId: c.shifts[0].id, fromCount: 1, types: [c.rosterMode === 'hospital' ? 'student' : 'resident'] },
              ],
            }))
          }
        >{t("➕ Presentation rule")}</button>
      )}
    </section>
  );
}

// ---------- join requests ----------

export function JoinRequests({ code, session, mutate, dirty }: SessionProps & { dirty: boolean }) {
  const pending = session.joinRequests.filter((r) => r.status === 'pending')
  const [link, setLink] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  if (pending.length === 0) return null
  return (
    <div className="joins">
      <strong>{t("Waiting to join (")}{pending.length})</strong>
      {dirty && <p className="small warn-text">{t("Save your setup changes first, then approve.")}</p>}
      {pending.map((r) => (
        <div key={r.id} className="row wrap join-row">
          <span>
            <strong>{r.name}</strong> <span className="muted small">{typeName(r.type)}</span>
          </span>
          <select value={link[r.id] ?? ''} onChange={(e) => setLink({ ...link, [r.id]: e.target.value })} aria-label={t('Who is {name}?', { name: r.name })}>
            <option value="">{t("Add as a new person")}</option>
            {session.config.members.filter((m) => session.config.rosterMode !== 'hospital' || m.type === 'student').map((m) => (
              <option key={m.id} value={m.id}>{t("This is")} {m.name}
                {session.claimed.includes(m.id) ? t(" (replaces their PIN)") : ''}
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
          >{t("✅ Approve")}</button>
          <button disabled={dirty} onClick={() => void mutate(() => api.decideJoin(code, r.id, false))}>{t("Reject")}</button>
        </div>
      ))}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

// ---------- who makes the resident/staff roster ----------

export function RosterModeCard({ draft, edit, ro }: { draft: SessionConfig; edit: Edit; ro: boolean }) {
  return (
    <section className="card">
      <h2 id="sec-mode">👩‍⚕️ {t('Residents & staff roster')}</h2>
      <div className="segmented wrap-seg" role="radiogroup" aria-label={t("Who makes the resident and staff roster")}>
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
            title={t(hint)}
            className={draft.rosterMode === v ? 'on' : ''}
            onClick={() => edit((c) => ({ ...c, rosterMode: v }))}
          >
            {v === 'hospital' ? '🏥' : '🤖'} {t(label)}
          </button>
        ))}
      </div>
      <p className="muted small">
        {draft.rosterMode === 'hospital'
          ? t(
          "Type or paste who the hospital put on duty each date (in “Hospital roster” below). Shift slots then describe student places, People lists only students, and Wayneday arranges only the students and presenters."
        )
          : t(
          "Wayneday schedules residents and staff from their availability and preferences, then arranges the students."
        )}
      </p>
    </section>
  );
}

// ---------- the hospital's roster (hospital mode) ----------

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const ROLE_LABEL: Record<DutyRole, string> = { resident: 'residents', staff: 'staff' }

/** Set the names in one hospital-roster cell, creating people for new names and dropping people no longer on it. */
function setDutyNames(c: SessionConfig, date: string, shiftId: string, role: DutyRole, names: string[]): SessionConfig {
  let members = [...c.members]
  const ids = names.map((name) => {
    let m = members.find((x) => x.type !== 'student' && norm(x.name) === norm(name))
    if (!m) {
      m = { id: uid(), name: name.trim(), type: role, jobs: [] }
      members.push(m)
    }
    return m.id
  })
  const duty = [
    ...c.duty.filter((a) => !(a.date === date && a.shiftId === shiftId && a.requirementId === role)),
    ...ids.map((memberId) => ({ date, shiftId, requirementId: role, memberId })),
  ]
  return pruneDoctors({ ...c, members, duty })
}

/** In hospital mode residents/staff exist only through the roster: drop the ones nobody lists any more. */
function pruneDoctors(c: SessionConfig): SessionConfig {
  const used = new Set(c.duty.map((a) => a.memberId))
  return { ...c, members: c.members.filter((m) => m.type === 'student' || used.has(m.id)) }
}

/** Parse a pasted table (from Excel / Google Sheets / CSV): Date, [Day], then residents and staff for each shift. */
function parseDutyPaste(text: string, draft: SessionConfig) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const delim = lines.some((l) => l.includes('\t')) ? '\t' : ','
  const rows = lines.map((l) => l.split(delim).map((c) => c.replace(/^"|"$/g, '').trim()))
  const cols = draft.shifts.flatMap((shift) => DUTY_ROLES.map((role) => ({ shift, role })))
  const days = dateRange(draft.startDate, draft.endDate)
  const toDate = (v: string): string | null => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return days.includes(v) ? v : null
    const m = /^(\d{1,2})(?:[/.-](\d{1,2}))?(?:[/.-](\d{2,4}))?$/.exec(v)
    if (!m) return null
    const day = Number(m[1])
    const month = m[2] ? Number(m[2]) : null
    return days.find((d) => Number(d.slice(8)) === day && (month === null || Number(d.slice(5, 7)) === month)) ?? null
  }
  // Header row → match "Night residents" / "Staff" etc.; otherwise Date, [Day], then the columns in order.
  let colMap: (number | null)[] = []
  let body = rows
  if (rows.length && !toDate(rows[0][0])) {
    colMap = rows[0].map((h) => {
      const head = norm(h)
      const role: DutyRole | null = /staff|อาจารย์|attending/.test(head) ? 'staff' : /resid|แพทย์ประจำบ้าน/.test(head) ? 'resident' : null
      if (!role) return null
      const i = cols.findIndex((c) => c.role === role && (draft.shifts.length === 1 || head.includes(norm(c.shift.name))))
      return i >= 0 ? i : null
    })
    body = rows.slice(1)
  }
  const cells: { date: string; shiftId: string; role: DutyRole; names: string[] }[] = []
  for (const r of body) {
    const date = toDate(r[0] ?? '')
    if (!date) continue
    const rest = colMap.length ? r : r.slice(1).filter((_, k) => !(k === 0 && /^[a-zก-๙.]{2,4}$/i.test(r[1] ?? '')))
    rest.forEach((cell, k) => {
      const ci = colMap.length ? colMap[k] : k
      if (ci === null || ci === undefined || !cols[ci]) return
      const names = cell.split(/[,/+&;]| and /).map((n) => n.trim()).filter((n) => n && n !== '—' && n !== '-')
      cells.push({ date, shiftId: cols[ci].shift.id, role: cols[ci].role, names })
    })
  }
  const known = new Set(draft.members.filter((m) => m.type !== 'student').map((m) => norm(m.name)))
  const newNames = [...new Set(cells.flatMap((c) => c.names).filter((n) => !known.has(norm(n))))]
  return { cells, newNames, readDays: new Set(cells.map((c) => c.date)).size }
}

/** Names typed into one cell, with suggestions from names already in the roster. */
function NameInput({
  names,
  suggestions,
  label,
  disabled,
  onChange,
}: {
  names: string[]
  suggestions: string[]
  label: string
  disabled: boolean
  onChange: (names: string[]) => void
}) {
  const [text, setText] = useState('')
  const [focus, setFocus] = useState(false)
  const [hi, setHi] = useState(0)
  const q = norm(text)
  const matches = q
    ? suggestions
        .filter((s) => !names.some((n) => norm(n) === norm(s)) && norm(s).includes(q))
        .sort((a, b) => Number(!norm(a).startsWith(q)) - Number(!norm(b).startsWith(q)))
        .slice(0, 6)
    : []
  const add = (name: string) => {
    const n = name.trim().replace(/,$/, '')
    if (n && !names.some((x) => norm(x) === norm(n))) onChange([...names, n])
    setText('')
    setHi(0)
  }
  return (
    <div className="names">
      {names.map((n, i) => (
        <span key={n} className="chip name-chip">
          {n}
          {!disabled && (
            <button type="button" className="x" aria-label={t('Remove {name}', { name: n })} onClick={() => onChange(names.filter((_, k) => k !== i))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          className="name-input"
          value={text}
          aria-label={label}
          placeholder={names.length ? '' : 'type a name'}
          onFocus={() => setFocus(true)}
          onBlur={() => {
            setFocus(false)
            if (text.trim()) add(text)
          }}
          onChange={(e) => {
            const v = e.target.value
            if (v.endsWith(',')) add(v)
            else setText(v)
            setHi(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHi((h) => Math.min(h + 1, matches.length))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHi((h) => Math.max(h - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              add(hi < matches.length ? matches[hi] : text)
            } else if (e.key === 'Backspace' && !text && names.length) {
              onChange(names.slice(0, -1))
            }
          }}
        />
      )}
      {focus && q && (
        <ul className="suggest" role="listbox" aria-label={`Suggestions for ${label}`}>
          {matches.map((m, i) => (
            <li key={m}>
              <button type="button" className={i === hi ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => add(m)}>
                {m}
              </button>
            </li>
          ))}
          {!matches.some((m) => norm(m) === q) && (
            <li>
              <button type="button" className={hi === matches.length ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => add(text)}>{t("Add “")}{text.trim()}”
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function DutyRosterCard({ draft, edit, ro }: { draft: SessionConfig; edit: Edit; ro: boolean }) {
  const [paste, setPaste] = useState('')
  const [parsed, setParsed] = useState<ReturnType<typeof parseDutyPaste> | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const days = dateRange(draft.startDate, draft.endDate)
  const cols = draft.shifts.flatMap((shift) => DUTY_ROLES.map((role) => ({ shift, role })))
  const title = (c: (typeof cols)[number]) => (draft.shifts.length > 1 ? `${c.shift.name} · ${t(ROLE_LABEL[c.role])}` : t(ROLE_LABEL[c.role]))
  const doctors = draft.members.filter((m) => m.type !== 'student')
  const nameOf = (id: string) => draft.members.find((m) => m.id === id)?.name ?? '?'
  const daysFilled = new Set(draft.duty.map((a) => a.date)).size
  // Same-role names first, then everyone else in the roster.
  const suggestFor = (role: DutyRole) => [...doctors.filter((m) => m.type === role), ...doctors.filter((m) => m.type !== role)].map((m) => m.name)
  const template = ['Date\tDay\t' + cols.map((c) => `${c.shift.name} ${ROLE_LABEL[c.role]}`).join('\t'), ...days.map((d) => `${d}\t${shortDate(d).split(' ')[0]}${'\t'.repeat(cols.length)}`)].join('\n')

  return (
    <section className="card">
      <h2 id="sec-duty">{t("🩺 Hospital roster")} <span className="badge">{daysFilled}/{days.length} {t("days")}</span>
      </h2>
      <p className="muted small">
        {t(
          'Who the hospital put on duty. Type names — Wayneday suggests names you’ve already used — or paste the hospital’s table from Excel or Google Sheets (first column = date, then {cols}). Separate several names with commas.',
          { cols: cols.map((c) => `${c.shift.name} ${t(ROLE_LABEL[c.role])}`).join(', ') },
        )}
      </p>
      {!ro && (
        <details className="paste">
          <summary className="small">{t("Paste from a spreadsheet")}</summary>
          <div className="stack">
            <div className="row wrap">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(template)
                    setMsg(t('Empty table copied — paste it into a spreadsheet, fill it in, then copy it back here.'))
                  } catch {
                    setMsg(t('Couldn’t copy. Make a spreadsheet with columns: {cols}', { cols: ['Date', 'Day', ...cols.map((c) => `${c.shift.name} ${ROLE_LABEL[c.role]}`)].join(', ') }))
                  }
                }}
              >{t("📋 Copy empty table")}</button>
              {draft.duty.length > 0 && (
                <button type="button" className="link danger" onClick={() => edit((c) => pruneDoctors({ ...c, duty: [] }))}>{t("Clear roster")}</button>
              )}
            </div>
            <textarea
              rows={3}
              aria-label={t("Pasted roster")}
              value={paste}
              placeholder={'1/11\tAnn, Bank\tDr. Somchai\n2/11\tPloy, Mint\tDr. Wipa'}
              onChange={(e) => {
                setPaste(e.target.value)
                setParsed(e.target.value.trim() ? parseDutyPaste(e.target.value, draft) : null)
              }}
            />
            {parsed && (
              <div className="row wrap">
                <span className="small">{t("Read")} {parsed.readDays} {t("day(s).")}{parsed.newNames.length > 0 && ` New names: ${parsed.newNames.join(', ')}.`}
                </span>
                <button
                  type="button"
                  className="primary"
                  disabled={parsed.cells.length === 0}
                  onClick={() => {
                    edit((c) => parsed.cells.reduce((acc, cell) => setDutyNames(acc, cell.date, cell.shiftId, cell.role, cell.names), c))
                    setPaste('')
                    setParsed(null)
                    setMsg(t('Filled {n} day(s). Save setup to keep it.', { n: parsed.readDays }))
                  }}
                >{t("✅ Use this")}</button>
              </div>
            )}
          </div>
        </details>
      )}
      {msg && <p className="small">{msg}</p>}
      <div className="scroll-x duty-wrap">
        <table className="roster duty">
          <thead>
            <tr>
              <th className="sticky">{t("Date")}</th>
              {cols.map((c) => (
                <th key={`${c.shift.id}-${c.role}`}>{title(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((date) => (
              <tr key={date} className={[0, 6].includes(weekday(date)) || draft.holidays.includes(date) ? 'weekend' : ''}>
                <th className="sticky nowrap">{shortDate(date)}</th>
                {cols.map((c) => {
                  if (!shiftRuns(draft, c.shift, date)) return <td key={`${c.shift.id}-${c.role}`} className="off" />
                  const names = draft.duty.filter((a) => a.date === date && a.shiftId === c.shift.id && a.requirementId === c.role).map((a) => nameOf(a.memberId))
                  return (
                    <td key={`${c.shift.id}-${c.role}`}>
                      <NameInput
                        names={names}
                        suggestions={suggestFor(c.role)}
                        label={`${shortDate(date)} ${title(c)}`}
                        disabled={ro}
                        onChange={(next) => edit((cfg) => setDutyNames(cfg, date, c.shift.id, c.role, next))}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
