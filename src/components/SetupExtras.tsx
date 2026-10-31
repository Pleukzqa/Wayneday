// Setup sections: date exceptions calendar, students, presentation rules, join requests.
import { Fragment, useState } from 'react'
import { api } from '../api.ts'
import { equalShareFor, studentOccs } from '../shared/students.ts'
import { t, typeName, weekdayLetter, weekdayLong, weekdayShort } from '../shared/i18n.ts'
import { dayPoints, fixedKey, fmtPoints, overrideFor, presentationOn, presentationUsually, reqCount, ruleSources, shiftHours, shiftPoints, shiftRuns, shiftTimes, sourceOffsets } from '../shared/calendar.ts'
import { addDays, dateRange, shortDate, weekday } from '../shared/dates.ts'
import { ANY_SHIFT, DEFAULT_POINTS, DUTY_ROLES, isOneDay, LAST_NIGHT, presentationPoints, type DateOverride, type DaysBack, type DutyRole, type MemberResponse, type MemberType, type PresentationOverride, type PresentationRule, type PresenterSource, type SessionConfig, type ShiftSlot } from '../shared/types.ts'
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
    ...(next.daysBack && String(next.daysBack) !== String(rule.daysBack ?? LAST_NIGHT) ? { daysBack: next.daysBack } : {}),
  }
  const isDefault =
    clean.active === presentationUsually(rule, date) && clean.count === undefined && clean.fromCount === undefined && clean.daysBack === undefined
  const rest = c.presentationOverrides.filter((o) => !(o.date === date && o.ruleId === ruleId))
  return { ...c, presentationOverrides: isDefault ? rest : [...rest, clean] }
}

/** Set (or with null, clear) a shift's hand-set final points; see PointSettings.fixed. */
function setFixedPoints(c: SessionConfig, key: string, value: number | null): SessionConfig {
  const p = { ...DEFAULT_POINTS, ...c.students.points }
  const fixed = { ...p.fixed }
  if (value === null) delete fixed[key]
  else fixed[key] = value
  return { ...c, students: { ...c.students, points: { ...p, fixed } } }
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
      next = setPresentation(next, target, r.id, p ? { active: true, count: p.count, fromCount: p.fromCount, daysBack: p.daysBack } : { active: false })
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
  const pointsOn = Boolean(draft.students.points?.on)
  const ownPoints = (date: string) => (pointsOn ? draft.datePoints?.[date] : undefined)
  const shiftOwnPoints = (shiftId: string, date: string) => (pointsOn ? draft.students.points?.fixed?.[fixedKey(shiftId, date)] : undefined)
  const changed = (date: string) =>
    draft.overrides.some((o) => o.date === date) ||
    draft.presentationOverrides.some((o) => o.date === date) ||
    ownPoints(date) !== undefined ||
    draft.shifts.some((s) => shiftOwnPoints(s.id, date) !== undefined)
  const setDatePoints = (date: string, value: number | null) =>
    edit((c) => {
      const next = { ...(c.datePoints ?? {}) }
      if (value === null) delete next[date]
      else next[date] = value
      return { ...c, datePoints: next }
    })
  const weekOf = (date: string) => days.filter((d) => Math.floor((dayIndex(d) + lead) / 7) === Math.floor((dayIndex(date) + lead) / 7))
  const dayIndex = (d: string) => days.indexOf(d)
  const sameWeekday = (date: string) => days.filter((d) => weekday(d) === weekday(date))
  const resetDates = (dates: string[]) =>
    edit((c) => ({
      ...c,
      overrides: c.overrides.filter((o) => !dates.includes(o.date)),
      presentationOverrides: c.presentationOverrides.filter((o) => !dates.includes(o.date)),
      datePoints: Object.fromEntries(Object.entries(c.datePoints ?? {}).filter(([d]) => !dates.includes(d))),
      ...(c.students.points?.fixed
        ? {
            students: {
              ...c.students,
              points: { ...c.students.points, fixed: Object.fromEntries(Object.entries(c.students.points.fixed).filter(([k]) => !dates.includes(k.split('|')[1]))) },
            },
          }
        : {}),
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
              {ownPoints(date) !== undefined && <span className="cal-pts">{fmtPoints(ownPoints(date)!)}pt</span>}
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
        {pointsOn && (
          <span>
            <b className="accent">3pt</b> {t('= this date has its own points')}</span>
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
                    {shiftTimes(s)}
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
                {runs && pointsOn && s.requirements.length > 0 && (
                  <label className="inline small" title={t('This shift’s points on this date only; other shifts keep theirs')}>
                    🎯
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      disabled={ro}
                      value={shiftPoints(draft, s.id, selected)}
                      onChange={(e) => edit((c) => setFixedPoints(c, fixedKey(s.id, selected), Math.max(0, Number(e.target.value) || 0)))}
                    />
                    {t('pt')}
                    {shiftOwnPoints(s.id, selected) !== undefined && !ro && (
                      <button type="button" className="link" onClick={() => edit((c) => setFixedPoints(c, fixedKey(s.id, selected), null))}>
                        {t('usual')}
                      </button>
                    )}
                  </label>
                )}
              </div>
            );
          })}
          {draft.presentations.filter((r) => !isOneDay(r) || presentationUsually(r, selected)).map((r) => {
            const p = presentationOn(draft, r, selected)
            const first = ruleSources(r)[0]
            const from = !first || first.shiftId === ANY_SHIFT ? t('any shift') : (draft.shifts.find((s) => s.id === first.shiftId)?.name ?? 'shift')
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
                    {ruleSources(r).length === 1 && (
                    <label className="inline small">{String(p.daysBack) === String(LAST_NIGHT) ? t('from last') : t('from')} {from}
                      <input
                        type="number"
                        min={0}
                        max={p.count}
                        disabled={ro}
                        value={p.fromCount}
                        onChange={(e) => edit((c) => setPresentation(c, selected, r.id, { fromCount: Math.min(p.count, Math.max(0, Number(e.target.value) || 0)) }))}
                      />
                    </label>
                    )}
                    {ruleSources(r).some((s) => s.when !== 'same') && (
                      <DaysBackSelect value={p.daysBack} disabled={ro} onChange={(daysBack) => edit((c) => setPresentation(c, selected, r.id, { daysBack }))} />
                    )}
                  </>
                )}
              </div>
            );
          })}
          {!ro && (
            <button type="button" className="link" onClick={() => edit((c) => ({ ...c, presentations: [...c.presentations, newPresentation(c, selected)] }))}>
              📌 {t('One-day presentation on this day')}
            </button>
          )}
          {pointsOn && (
            <div className="row wrap cal-points">
              <label className="inline">
                🎯 {t('Points for this day')}{' '}
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  disabled={ro}
                  value={dayPoints(draft, selected)}
                  onChange={(e) => setDatePoints(selected, Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              {ownPoints(selected) !== undefined ? (
                !ro && (
                  <button type="button" className="link" onClick={() => setDatePoints(selected, null)}>
                    {t('Use the usual points')}
                  </button>
                )
              ) : (
                <span className="muted small">{t('(usual for this day)')}</span>
              )}
            </div>
          )}
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

/** Points per shift: weekday / weekend-holiday values, and an optional multiplier per shift slot. */
function PointsBox({ draft, ro, set, count }: { draft: SessionConfig; ro: boolean; set: (patch: Partial<SessionConfig['students']>) => void; count: number }) {
  const p = { ...DEFAULT_POINTS, ...draft.students.points }
  const setP = (patch: Partial<typeof p>) => set({ points: { ...p, ...patch } })
  const slots = draft.shifts.filter((x) => x.requirements.length > 0)
  const occs = studentOccs(draft, [])
  // Suggested multipliers from shift length: the shortest slot counts 1, others by their hours (to the nearest 0.5).
  const hours = slots.map((x) => shiftHours(x))
  const shortest = Math.min(...hours.filter((h) => h > 0))
  const suggested = Object.fromEntries(slots.map((x, i) => [x.id, hours[i] > 0 ? Math.round((hours[i] / shortest) * 2) / 2 : 1]))
  const usingSuggested = slots.every((x) => (p.shifts?.[x.id] ?? 1) === suggested[x.id])
  const value = (v: number, on: (n: number) => void, label: string) => (
    <input type="number" min={0} max={100} step={0.5} disabled={ro} aria-label={label} value={v} onChange={(e) => on(Math.max(0, Number(e.target.value) || 0))} />
  )
  return (
    <div className="points-box">
      <label className="check">
        <input type="checkbox" disabled={ro} checked={p.on} onChange={(e) => setP({ on: e.target.checked })} />
        🎯 {t('Count points, so everyone’s points come out about equal')}
      </label>
      {p.on && (
        <>
          <div className="row wrap">
            <label className="inline">
              {t('Weekday shift')} {value(p.weekday, (n) => setP({ weekday: n }), t('Weekday shift'))} {t('pt')}
            </label>
            <label className="inline">
              {t('Weekend / holiday shift')} {value(p.weekend, (n) => setP({ weekend: n }), t('Weekend / holiday shift'))} {t('pt')}
            </label>
          </div>
          <label className="inline">
            {t('Points may differ by at most')}{' '}
            <input
              type="number"
              min={1}
              max={100}
              disabled={ro}
              placeholder="—"
              aria-label={t('Points may differ by at most')}
              value={p.maxDiff ?? ''}
              onChange={(e) => setP({ maxDiff: e.target.value === '' ? undefined : Math.min(100, Math.max(1, Math.round(Number(e.target.value)) || 1)) })}
            />{' '}
            {t('% of the average between students')}{' '}
            <span className="muted small">{t('(empty = no limit; e.g. 20% of an average of 18 points allows 16–20)')}</span>
          </label>
          {slots.length > 1 && (
            <div className="stack-tight">
              <span className="small">{t('Worth more on some shift slots? Multiply by:')}</span>
              {slots.map((x, i) => (
                <div key={x.id} className="row wrap">
                  <label className="inline">
                    {x.name} × {value(p.shifts?.[x.id] ?? 1, (n) => setP({ shifts: { ...p.shifts, [x.id]: n } }), x.name)}
                  </label>
                  <span className="muted small">{t('{h} hours → suggested × {m}', { h: fmtPoints(hours[i]), m: fmtPoints(suggested[x.id]) })}</span>
                </div>
              ))}
              {!ro && !usingSuggested && (
                <button type="button" className="link" onClick={() => setP({ shifts: suggested })}>
                  ⏱️ {t('Use the suggested numbers (by hours)')}
                </button>
              )}
            </div>
          )}
          {draft.presentations.length > 0 && (
            <label className="check">
              <input type="checkbox" disabled={ro} checked={Boolean(p.presentations)} onChange={(e) => setP({ presentations: e.target.checked || undefined })} />
              {t('Presenting counts towards points too — whoever presents less gets heavier shifts, and the other way round')}
              <span className="muted small"> {t('(each presentation’s points are set in its box under Presentations)')}</span>
            </label>
          )}
          <PointsSummary draft={draft} occs={occs} count={count} ro={ro} setFixed={(key, value) => setP({ fixed: setFixedPoints(draft, key, value).students.points!.fixed })} />
          <p className="muted small">
            {t('Special days, e.g. 3 points the day before an exam: tap the date in the calendar above.')}{' '}
            {t('Shift counts stay equal first; points are then made as equal as possible.')}
          </p>
        </>
      )}
    </div>
  )
}

/** What each shift earns: day points × the slot's multiplier, per shift slot and kind of day, with how many places. */
function PointsSummary({
  draft,
  occs,
  count,
  ro,
  setFixed,
}: {
  draft: SessionConfig
  occs: ReturnType<typeof studentOccs>
  count: number
  ro: boolean
  setFixed: (key: string, value: number | null) => void
}) {
  const p = { ...DEFAULT_POINTS, ...draft.students.points }
  type Row = { shiftId: string; kind: string; label: string; day: number; places: number; pts: number }
  const rows = new Map<string, Row>()
  for (const o of occs) {
    // A date gets its own row when it has its own points, for every slot or just this one.
    const own = draft.datePoints?.[o.date] !== undefined || p.fixed?.[fixedKey(o.shiftId, o.date)] !== undefined
    const kind = own ? o.date : o.weekend ? 'weekend' : 'weekday'
    const key = `${o.shiftId}|${kind}`
    const row = rows.get(key) ?? {
      shiftId: o.shiftId,
      kind,
      label: own ? shortDate(o.date) : o.weekend ? t('Weekend / holiday') : t('Weekday'),
      day: dayPoints(draft, o.date),
      places: 0,
      pts: o.pts,
    }
    row.places += o.cap
    rows.set(key, row)
  }
  const order = (r: Row) => [draft.shifts.findIndex((s) => s.id === r.shiftId), r.kind === 'weekday' ? 0 : r.kind === 'weekend' ? 1 : 2, r.kind] as const
  const list = [...rows.values()].sort((a, b) => {
    const [x, y] = [order(a), order(b)]
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2])
  })
  if (!list.length) return null
  // Presentations counting towards points: how many there are of each, and what they're worth.
  const talks = p.presentations
    ? draft.presentations
        .map((r) => ({ rule: r, n: dateRange(draft.startDate, draft.endDate).reduce((a, d) => a + (presentationOn(draft, r, d)?.count ?? 0), 0) }))
        .filter((x) => x.n > 0)
    : []
  const places = list.reduce((n, r) => n + r.places, 0)
  const total = list.reduce((n, r) => n + r.places * r.pts, 0) + talks.reduce((n, x) => n + x.n * presentationPoints(x.rule), 0)
  const name = (id: string) => draft.shifts.find((s) => s.id === id)?.name ?? ''
  return (
    <div className="scroll-x">
      <table className="mini points-sum">
        <caption className="small">{t('How points add up')}</caption>
        <thead>
          <tr>
            <th>{t('Shift slot')}</th>
            <th>{t('Day')}</th>
            <th>{t('Points per shift')}</th>
            <th>{t('Places')}</th>
            <th>{t('Points')}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r, i) => {
            const m = p.shifts?.[r.shiftId] ?? 1
            const key = fixedKey(r.shiftId, r.kind)
            const byHand = p.fixed?.[key] !== undefined
            return (
              <tr key={`${r.shiftId}|${r.kind}`}>
                <td>{i === 0 || list[i - 1].shiftId !== r.shiftId ? name(r.shiftId) : ''}</td>
                <td>{r.label}</td>
                <td className="nowrap">
                  {!byHand && m !== 1 && <span className="muted">{fmtPoints(r.day)} × {fmtPoints(m)} = </span>}
                  {ro ? (
                    <b>{fmtPoints(r.pts)}</b>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      aria-label={t('Points per shift')}
                      title={t('Set this shift’s points by hand; other shifts keep theirs')}
                      className={byHand ? 'by-hand' : ''}
                      value={r.pts}
                      onChange={(e) => setFixed(key, Math.max(0, Number(e.target.value) || 0))}
                    />
                  )}
                  {byHand && (
                    <>
                      {' '}
                      <span className="muted small">✋</span>
                      {!ro && (
                        <button
                          type="button"
                          className="link small"
                          title={t('Back to the calculation: {calc}', { calc: `${fmtPoints(r.day)} × ${fmtPoints(m)} = ${fmtPoints(r.day * m)}` })}
                          onClick={() => setFixed(key, null)}
                        >
                          ↺
                        </button>
                      )}
                    </>
                  )}
                </td>
                <td>{r.places}</td>
                <td>{fmtPoints(r.places * r.pts)}</td>
              </tr>
            )
          })}
          {talks.map((x) => (
            <tr key={x.rule.id} className="talk-row">
              <td>🎤 {x.rule.name}</td>
              <td>{t('presentations')}</td>
              <td>
                <b>{fmtPoints(presentationPoints(x.rule))}</b>
              </td>
              <td>{x.n}</td>
              <td>{fmtPoints(x.n * presentationPoints(x.rule))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={3}>{t('Total')}</th>
            <th>{places}</th>
            <th>{fmtPoints(total)}</th>
          </tr>
          {count > 0 && (
            <tr>
              <td colSpan={5} className="muted small">
                {t('{p} points ÷ {n} students ≈ {a} each, if every place is filled.', { p: fmtPoints(total), n: count, a: fmtPoints(Math.round((total / count) * 10) / 10) })}
              </td>
            </tr>
          )}
        </tfoot>
      </table>
    </div>
  )
}

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
              : share.groups > 1
                ? t('{p} student places, shared within {g} groups of students who take different places (e.g. two rotations) → {a}–{b} shifts each.', {
                    p: share.total,
                    g: share.groups,
                    a: share.range[0],
                    b: share.range[1],
                  })
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
        <PointsBox draft={draft} ro={ro} set={set} count={count} />
        <label className="inline">{t("A student’s shifts at least")} <input type="number" min={0} max={60} disabled={ro} value={st.minGap ?? 0} onChange={(e) => set({ minGap: Math.max(0, Number(e.target.value) || 0) })} /> {t("days apart")} <span className="muted small">{t("(0 = each student’s own answer)")}</span>
        </label>
        {slots.length > 1 && (
          <div className="rules">
            <span className="small" title={t('Everyone gets about as many of these (at most 1 apart in a group); points can’t make up for fewer.')}>
              {t('Always even (at most 1 apart):')}
            </span>
            {slots.map((x) => (
              <label key={x.id} className="check">
                <input
                  type="checkbox"
                  disabled={ro}
                  checked={Boolean(st.evenSlots?.includes(x.id))}
                  onChange={(e) => set({ evenSlots: e.target.checked ? [...(st.evenSlots ?? []), x.id] : (st.evenSlots ?? []).filter((y) => y !== x.id) })}
                />
                {x.name}
              </label>
            ))}
          </div>
        )}
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

type SourceOption = { value: string; label: string }
/** A source's label with the other shifts that count the same: "Night · 19C, or Weekend night". */
const withOr = (label: string, s: PresenterSource, name: (id: string) => string) =>
  s.orShiftIds?.length ? `${label}, ${s.orShiftIds.map((id) => t('or {shift}', { shift: name(id) })).join(', ')}` : label
/** How the diagram names a source: "shift|place|job". */
const srcValue = (s: Pick<PresenterSource, 'shiftId' | 'placeId' | 'jobId'>) => `${s.shiftId}|${s.placeId ?? ''}|${s.jobId ?? ''}`

/** A new presentation: weekly (a morning report) or, given a date, on that day only (a case discussion). */
/** "Was on duty" choices for presenter sources: last night, or further back. */
const DAYS_BACK: DaysBack[] = [[1, 1], [2, 2], [3, 3], [1, 2], [2, 3], [1, 3]]
const isLastNight = (d: DaysBack) => d[0] === 1 && d[1] === 1
const daysBackText = (d: DaysBack) =>
  isLastNight(d) ? t('last night') : d[0] === d[1] ? t('{n} days before', { n: d[0] }) : t('{a}–{b} days before', { a: d[0], b: d[1] })
/** When a source's presenters were on duty, for summaries: "the day before", "2–3 days before", "the same day". */
const whenText = (s: PresenterSource, d: DaysBack) => (s.when === 'same' ? t('the same day') : isLastNight(d) ? t('the day before') : daysBackText(d))

function DaysBackSelect({ value, disabled, onChange }: { value: DaysBack; disabled: boolean; onChange: (d: DaysBack) => void }) {
  const choices = DAYS_BACK.some((d) => String(d) === String(value)) ? DAYS_BACK : [...DAYS_BACK, value]
  return (
    <label className="inline small">
      {t('was on duty')}{' '}
      <select value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value.split(',').map(Number) as DaysBack)}>
        {choices.map((d) => (
          <option key={String(d)} value={String(d)}>{daysBackText(d)}</option>
        ))}
      </select>
    </label>
  )
}

function newPresentation(c: SessionConfig, date?: string): PresentationRule {
  const base = { id: uid(), fromShiftId: c.shifts[0]?.id ?? ANY_SHIFT, fromCount: 1, types: [c.rosterMode === 'hospital' ? ('student' as const) : ('resident' as const)] }
  return date
    ? { ...base, name: t('Case discussion'), days: [], dates: [date], count: 1 }
    : { ...base, name: t('Morning round'), days: [1, 2, 3, 4, 5], count: 2 }
}

/**
 * Who presents, as a small diagram: the shifts (and their places) on the left, the presentation on the
 * right. Tapping a shift or place links it ("at least 1 from here"); the steppers set how many.
 */
function PresenterFlow({
  rule,
  options,
  running,
  ro,
  setSources,
  setDaysBack,
  shifts,
  suggestOr,
}: {
  rule: PresentationRule
  options: SourceOption[]
  shifts: ShiftSlot[]
  /** For a linked shift that doesn't run before some of the presentation's days: the shift that does, and those days. */
  suggestOr: (src: PresenterSource) => { shift: ShiftSlot; dates: string[] } | null
  /** Shift ids that run the day before / the same day as the presentation; null = don't filter. */
  running: Record<'before' | 'same', Set<string> | null>
  ro: boolean
  setSources: (p: PresentationRule, sources: PresenterSource[], extra?: Partial<PresentationRule>) => void
  setDaysBack: (p: PresentationRule, d: DaysBack) => void
}) {
  const daysBack = rule.daysBack ?? LAST_NIGHT
  const sources = ruleSources(rule)
  const [showSame, setShowSame] = useState(sources.some((s) => s.when === 'same'))
  const keyOf = (s: Pick<PresenterSource, 'shiftId' | 'placeId' | 'jobId' | 'when'>) => `${s.when ?? 'before'}|${srcValue(s)}`
  const countOf = (key: string) => sources.find((s) => keyOf(s) === key)?.count ?? 0
  const linked = sources.reduce((n, s) => n + s.count, 0)
  const shiftName = (id: string) => shifts.find((x) => x.id === id)?.name ?? '?'
  const labelOf = (s: PresenterSource) => withOr(options.find((o) => o.value === srcValue(s))?.label ?? '?', s, shiftName)
  const setOr = (src: PresenterSource, ids: string[]) =>
    setSources(
      rule,
      sources.map((s) => {
        if (s !== src) return s
        const { orShiftIds: _o, ...rest } = s
        return ids.length ? { ...rest, orShiftIds: ids } : rest
      }),
    )

  const setCount = (when: 'before' | 'same', value: string, n: number) => {
    const [shiftId, placeId, jobId] = value.split('|')
    const key = keyOf({ shiftId, placeId: placeId || undefined, jobId: jobId || undefined, when })
    const others = sources.filter((s) => keyOf(s) !== key)
    // Linking more than there are seats adds seats (up to 20 presenters).
    const taken = others.reduce((x, s) => x + s.count, 0)
    const count = Math.max(0, Math.min(n, 20 - taken))
    const existing = sources.find((s) => keyOf(s) === key)
    const next = count > 0 ? [...others, { ...existing, shiftId, ...(placeId ? { placeId } : {}), ...(jobId ? { jobId } : {}), count, when }] : others
    // Same order as the diagram, so the first source is stable.
    const order = (s: PresenterSource) => (s.when === 'same' ? 1000 : 0) + options.findIndex((o) => o.value === srcValue(s))
    setSources(rule, next.sort((a, b) => order(a) - order(b)), taken + count > rule.count ? { count: taken + count } : {})
  }

  // Only shifts that run then; one already linked stays, marked, so it can be unlinked.
  const runs = (when: 'before' | 'same', value: string) => {
    const [shiftId, , jobId] = value.split('|')
    if (!running[when]) return true
    return shiftId === ANY_SHIFT ? !jobId || running[when].has(`job:${jobId}`) : running[when].has(shiftId)
  }
  const group = (when: 'before' | 'same', title: string) => (
    <div className="flow-group">
      <span className="flow-title">{title}</span>
      {when === 'before' && <DaysBackSelect value={daysBack} disabled={ro} onChange={(d) => setDaysBack(rule, d)} />}
      {options.length > 1 && options.every((o) => !runs(when, o.value) || o.value === `${ANY_SHIFT}||`) && (
        <span className="muted small">{t('No shifts run then.')}</span>
      )}
      {options.map((o) => {
        const key = `${when}|${o.value}`
        const n = countOf(key)
        const isPlace = !o.value.endsWith('||')
        const off = !runs(when, o.value)
        if (off && n === 0) return null
        return (
          <Fragment key={key}>
          <div className={`flow-row ${n > 0 ? 'on' : ''} ${isPlace ? 'place' : ''} ${off ? 'off' : ''}`}>
            <button
              type="button"
              className="flow-node"
              disabled={ro}
              aria-pressed={n > 0}
              title={off ? t('This shift doesn’t run then — tap to unlink it') : undefined}
              onClick={() => setCount(when, o.value, n > 0 ? 0 : 1)}
            >
              {off && '⚠️ '}
              {o.label}
            </button>
            <span className="flow-step">
              {n > 0 && !ro && (
                <button type="button" aria-label={t('Fewer')} onClick={() => setCount(when, o.value, n - 1)}>
                  −
                </button>
              )}
              {n > 0 && <b>{n}</b>}
              {n > 0 && !ro && (
                <button type="button" aria-label={t('More')} disabled={linked >= 20} onClick={() => setCount(when, o.value, n + 1)}>
                  +
                </button>
              )}
            </span>
            <span className="flow-wire" aria-hidden />
          </div>
          {n > 0 && o.value.split('|')[0] !== ANY_SHIFT && (() => {
            const src = sources.find((s) => keyOf(s) === key)!
            const alts = src.orShiftIds ?? []
            const tip = suggestOr(src)
            const more = shifts.filter((x) => x.id !== src.shiftId && !alts.includes(x.id))
            if (!alts.length && !tip && (ro || !more.length)) return null
            return (
              <div className="flow-or small">
                {alts.map((id) => (
                  <span key={id} className="chip">
                    {t('or {shift}', { shift: shiftName(id) })}
                    {!ro && (
                      <button type="button" className="x" aria-label={t('Remove')} onClick={() => setOr(src, alts.filter((x) => x !== id))}>
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {tip && !ro && (
                  <button
                    type="button"
                    className="link"
                    title={t('{shift} doesn’t run before {dates}', { shift: shiftName(src.shiftId), dates: tip.dates.slice(0, 4).map(shortDate).join(', ') })}
                    onClick={() => setOr(src, [...alts, tip.shift.id])}
                  >
                    ➕ {t('or {shift} (runs before {days})', { shift: tip.shift.name, days: [...new Set(tip.dates.map((d) => weekdayShort()[weekday(d)]))].join(', ') })}
                  </button>
                )}
                {!ro && more.length > 0 && (
                  <select aria-label={t('Also counts: another shift')} value="" onChange={(e) => e.target.value && setOr(src, [...alts, e.target.value])}>
                    <option value="">{t('or another shift…')}</option>
                    {more.map((x) => (
                      <option key={x.id} value={x.id}>{x.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )
          })()}
          </Fragment>
        )
      })}
    </div>
  )

  return (
    <div className="flow">
      <div className="flow-left">
        {group('before', isLastNight(daysBack) ? t('Last night’s shifts') : t('Shifts {when}', { when: daysBackText(daysBack) }))}
        {showSame ? (
          group('same', t('Same-day shifts'))
        ) : (
          !ro && (
            <button type="button" className="link small" onClick={() => setShowSame(true)}>
              ➕ {t('Also from same-day shifts (e.g. weekend rounds)')}
            </button>
          )
        )}
      </div>
      <div className="flow-box">
        <strong>🎤 {rule.name}</strong>
        <label className="inline">
          <input
            type="number"
            min={1}
            max={20}
            disabled={ro}
            value={rule.count}
            onChange={(e) => {
              const count = Math.max(1, Number(e.target.value) || 1)
              let left = count
              setSources(
                rule,
                sources.map((s) => {
                  const n = Math.min(s.count, left)
                  left -= n
                  return { ...s, count: n }
                }).filter((s) => s.count > 0),
                { count },
              )
            }}
          />{' '}
          {t('presenter(s) each time')}
        </label>
        <label className="inline small">
          {t('Each presentation counts as')}{' '}
          <input
            type="number"
            min={0}
            max={20}
            step={0.5}
            disabled={ro}
            value={presentationPoints(rule)}
            onChange={(e) => setSources(rule, sources, { points: Math.max(0, Number(e.target.value) || 0) })}
          />{' '}
          {t('point(s)')}
        </label>
        <ul>
          {sources.map((s) => (
            <li key={keyOf(s)}>
              {t('{n} from {place}, {when}', { n: s.count, place: labelOf(s), when: whenText(s, daysBack) })}
            </li>
          ))}
          {rule.count - linked > 0 && <li className="muted">{t('{n} from anyone', { n: rule.count - linked })}</li>}
        </ul>
        {!ro && <span className="muted small">{t('Tap a shift or a place on the left to require presenters from it.')}</span>}
      </div>
    </div>
  )
}

export function PresentationsCard({ draft, edit, ro }: { draft: SessionConfig; edit: Edit; ro: boolean }) {
  const set = (id: string, patch: Partial<PresentationRule>) =>
    edit((c) => ({ ...c, presentations: c.presentations.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  // The old single "from" fields mirror the first source, so rules stay readable by older code.
  const setSources = (p: PresentationRule, sources: PresenterSource[], extra: Partial<PresentationRule> = {}) =>
    set(p.id, { ...extra, sources, fromShiftId: sources[0]?.shiftId ?? p.fromShiftId, fromCount: sources[0]?.count ?? 0 })
  const job = (id: string) => draft.jobs.find((j) => j.id === id)?.name ?? ''
  const oneDay = draft.presentations.filter(isOneDay).sort((a, b) => (a.dates?.[0] ?? '').localeCompare(b.dates?.[0] ?? ''))
  // Any shift, each shift, and each place of a shift that has several.
  // Any shift, each place (ward) on whichever shift, each shift, and each place of a shift that has several.
  const usedJobs = draft.jobs.filter((j) => draft.shifts.some((s) => s.requirements.some((r) => r.jobId === j.id)))
  const sourceOptions = [
    { value: `${ANY_SHIFT}||`, label: t('any shift') },
    ...(usedJobs.length > 1 ? usedJobs.map((j) => ({ value: `${ANY_SHIFT}||${j.id}`, label: t('{place} · any shift', { place: j.name }) })) : []),
    ...draft.shifts.flatMap((s) => [
      { value: `${s.id}||`, label: s.name },
      ...(s.requirements.length > 1
        ? s.requirements.map((r, i) => ({ value: `${s.id}|${r.id}|`, label: `${s.name} · ${r.jobId ? job(r.jobId) : t('place {n}', { n: i + 1 })}` }))
        : []),
    ]),
  ]
  // Which shifts run the day before / the same day, on the dates this presentation happens.
  const runningFor = (p: PresentationRule): Record<'before' | 'same', Set<string> | null> => {
    const dates = isOneDay(p) ? (p.dates ?? []) : dateRange(draft.startDate, draft.endDate).filter((d) => presentationOn(draft, p, d))
    if (!dates.length) return { before: null, same: null }
    // Shift ids, and `job:<id>` for each place those shifts have, running that many days before.
    const on = (offsets: (date: string) => number[]) =>
      new Set(
        draft.shifts
          .filter((s) => dates.some((d) => offsets(d).some((n) => shiftRuns(draft, s, addDays(d, -n)))))
          .flatMap((s) => [s.id, ...s.requirements.filter((r) => r.jobId).map((r) => `job:${r.jobId}`)]),
      )
    const back = (d: string) => sourceOffsets({ shiftId: ANY_SHIFT, count: 1 }, presentationOn(draft, p, d)?.daysBack ?? p.daysBack ?? LAST_NIGHT)
    return { before: on(back), same: on(() => [0]) }
  }
  // A linked shift that doesn't run before some of the presentation's days: the shift that does, with the same place.
  const suggestOr = (p: PresentationRule) => (src: PresenterSource) => {
    if (src.shiftId === ANY_SHIFT) return null
    const dates = isOneDay(p) ? (p.dates ?? []) : dateRange(draft.startDate, draft.endDate).filter((d) => presentationOn(draft, p, d))
    const before = (d: string) => sourceOffsets(src, presentationOn(draft, p, d)?.daysBack ?? p.daysBack ?? LAST_NIGHT).map((n) => addDays(d, -n))
    const linked = [src.shiftId, ...(src.orShiftIds ?? [])].map((id) => draft.shifts.find((x) => x.id === id)).filter((x): x is ShiftSlot => Boolean(x))
    const missing = dates.filter((d) => !before(d).some((day) => linked.some((sh) => shiftRuns(draft, sh, day))))
    if (!missing.length) return null
    const main = draft.shifts.find((x) => x.id === src.shiftId)
    const job = src.placeId ? main?.requirements.find((r) => r.id === src.placeId)?.jobId : src.jobId
    const fits = draft.shifts.filter(
      (sh) =>
        !linked.includes(sh) &&
        missing.some((d) => before(d).some((day) => shiftRuns(draft, sh, day))) &&
        (!job || sh.requirements.some((r) => r.jobId === job)),
    )
    // Prefer the one ending when the main one does: the same night, another version of it.
    const shift = [...fits].sort((a, b) => Number(b.end === main?.end) - Number(a.end === main?.end))[0]
    return shift ? { shift, dates: missing } : null
  }
  const sourcesText = (p: PresentationRule) => {
    const list = ruleSources(p)
    if (!list.length) return t('anyone')
    return list
      .map((s) =>
        t('{n} from {place}, {when}', {
          n: s.count,
          place: withOr(sourceOptions.find((o) => o.value === srcValue(s))?.label ?? '?', s, (id) => draft.shifts.find((x) => x.id === id)?.name ?? '?'),
          when: whenText(s, p.daysBack ?? LAST_NIGHT),
        }),
      )
      .join(' · ')
  }
  return (
    <section className="card">
      <h2 id="sec-presentations">🎤 {t('Presentations')}</h2>
      <p className="muted small">{t(
        "E.g. morning report: on weekdays, 2 cases are presented and at least 1 presenter must be someone coming off last night’s shift. Wayneday picks presenters and shares the load evenly."
      )}</p>
      {draft.presentations.filter((p) => !isOneDay(p)).map((p) => (
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
          <PresenterFlow rule={p} options={sourceOptions} running={runningFor(p)} ro={ro} setSources={setSources} setDaysBack={(r, daysBack) => set(r.id, { daysBack: isLastNight(daysBack) ? undefined : daysBack })} shifts={draft.shifts} suggestOr={suggestOr(p)} />
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
      {oneDay.length > 0 && (
        <div className="oneday-list">
          <h3>📌 {t('One-day presentations')}</h3>
          {oneDay.map((p) => (
            <div key={p.id} className="oneday">
              <div className="row wrap">
                <input
                  type="date"
                  aria-label={t('Date')}
                  value={p.dates?.[0] ?? ''}
                  min={draft.startDate}
                  max={draft.endDate}
                  disabled={ro}
                  onChange={(e) => e.target.value && set(p.id, { dates: [e.target.value] })}
                />
                <input className="grow" aria-label={t('Name')} value={p.name} disabled={ro} onChange={(e) => set(p.id, { name: e.target.value })} />
                {!ro && (
                  <button type="button" className="x" aria-label={t('Remove')} onClick={() => edit((c) => ({ ...c, presentations: c.presentations.filter((x) => x.id !== p.id) }))}>
                    ×
                  </button>
                )}
              </div>
              <details>
                <summary className="small">
                  🎤 {t('{n} presenter(s)', { n: p.count })} · {sourcesText(p)}
                </summary>
                <PresenterFlow rule={p} options={sourceOptions} running={runningFor(p)} ro={ro} setSources={setSources} setDaysBack={(r, daysBack) => set(r.id, { daysBack: isLastNight(daysBack) ? undefined : daysBack })} shifts={draft.shifts} suggestOr={suggestOr(p)} />
              </details>
            </div>
          ))}
        </div>
      )}
      {!ro && draft.shifts.length > 0 && (
        <div className="row wrap">
          <button type="button" onClick={() => edit((c) => ({ ...c, presentations: [...c.presentations, newPresentation(c)] }))}>
            ➕ {t('Weekly presentation')}
          </button>
          <button type="button" onClick={() => edit((c) => ({ ...c, presentations: [...c.presentations, newPresentation(c, c.startDate)] }))}>
            📌 {t('One-day presentation')}
          </button>
        </div>
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
      <h2 id="sec-duty">
        {t("🩺 Hospital roster")} <span className="badge">{draft.noDuty ? t('left blank') : `${daysFilled}/${days.length} ${t('days')}`}</span>
      </h2>
      <label className="check">
        <input type="checkbox" disabled={ro} checked={Boolean(draft.noDuty)} onChange={(e) => edit((c) => ({ ...c, noDuty: e.target.checked || undefined }))} />
        {t('Leave it blank — we don’t know the hospital roster (yet)')}
      </label>
      {draft.noDuty ? (
        <p className="muted small">
          {t('Students are arranged on their own. Rules about meeting the same resident or staff member, and spreading students between them, don’t apply. Untick this when you have the roster.')}
          {draft.duty.length > 0 && ` ${t('What you’ve already entered ({n} entries) is kept, but not used.', { n: draft.duty.length })}`}
        </p>
      ) : (
      <>
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
      </>
      )}
    </section>
  );
}
