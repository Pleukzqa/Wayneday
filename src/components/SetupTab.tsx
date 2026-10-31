import { useMemo, useState } from 'react'
import { api } from '../api.ts'
import { addDays, dateRange } from '../shared/dates.ts'
import type { Member, MemberType, PlacePeriod, Requirement, SessionConfig, ShiftSlot } from '../shared/types.ts'
import { IS_DEMO, sessionHash } from '../routes.ts'
import { endDays, fmtPoints, reqCount, shiftHours } from '../shared/calendar.ts'
import { t, weekdayLetter } from '../shared/i18n.ts'
import ConfirmButton from './ConfirmButton.tsx'
import { CalendarCard, DutyRosterCard, JoinRequests, PresentationsCard, RosterModeCard, StudentsCard } from './SetupExtras.tsx'
import { uid, type SessionProps } from './props.ts'

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

/** A sensible starting point for a brand-new session: next month, one ward, a nightly resident shift. */
function starter(c: SessionConfig): SessionConfig {
  if (c.shifts.length || c.jobs.length || c.members.length) return c
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
  const end = addDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).toISOString().slice(0, 10), -1)
  return {
    ...c,
    startDate: start,
    endDate: end,
    jobs: [],
    shifts: [
      {
        id: uid(),
        name: 'Night',
        start: '16:00',
        end: '08:00',
        days: ALL_DAYS,
        requirements: [{ id: uid(), jobId: '', memberType: 'resident', count: 1 }],
      },
    ],
  }
}

export default function SetupTab({ code, session, me, mutate }: SessionProps) {
  // null = no local edits, so the form follows the server copy.
  const [localDraft, setDraft] = useState<SessionConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bulk, setBulk] = useState('')
  const [bulkType, setBulkType] = useState<MemberType>('resident')

  const base = useMemo(() => (me.isHost ? starter(session.config) : session.config), [me.isHost, session.config])
  const draft = localDraft ?? base
  const dirty = draft !== session.config

  const edit = (fn: (c: SessionConfig) => SessionConfig) => setDraft((c) => fn(c ?? base))
  const ro = !me.isHost

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await mutate(() => api.saveConfig(code, draft))
      setDraft(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const setShift = (id: string, fn: (s: ShiftSlot) => ShiftSlot) =>
    edit((c) => ({ ...c, shifts: c.shifts.map((s) => (s.id === id ? fn(s) : s)) }))
  const setReq = (shiftId: string, reqId: string, patch: Partial<Requirement>) =>
    setShift(shiftId, (s) => ({ ...s, requirements: s.requirements.map((r) => (r.id === reqId ? { ...r, ...patch } : r)) }))
  const setMember = (id: string, patch: Partial<Member>) =>
    edit((c) => ({ ...c, members: c.members.map((m) => (m.id === id ? { ...m, ...patch } : m)) }))

  const days = dateRange(draft.startDate, draft.endDate)
  const positionsPerPeriod = days.reduce(
    (n, d) => n + draft.shifts.reduce((k, s) => k + s.requirements.reduce((a, r) => a + reqCount(draft, s, r, d), 0), 0),
    0,
  )
  const workers = draft.members.filter((m) => m.type !== 'student').length
  // Hospital mode: residents/staff exist only through the hospital roster, so People lists students.
  const hospital = draft.rosterMode === 'hospital'
  // The place/job column only matters when there are places to pick from.
  const showJobs = !hospital || draft.jobs.length > 0 || draft.shifts.some((s) => s.requirements.some((r) => r.jobId))
  const shownPeople = hospital ? draft.members.filter((m) => m.type === 'student') : draft.members
  const doctorCount = draft.members.length - shownPeople.length

  return (
    <div className="stack">
      {ro && <p className="muted">{t("Only the host can change the setup. This is what they've configured.")}</p>}
      <nav className="jump" aria-label={t('Jump to')}>
        {(
          [
            ['sec-period', '📆', 'Period'],
            ['sec-mode', '👩‍⚕️', 'Roster type'],
            ['sec-shifts', '🏥', 'Shift slots'],
            ['sec-calendar', '🗓️', 'Calendar'],
            ['sec-people', '🎓', hospital ? 'Students' : 'People'],
            ...(hospital ? [['sec-duty', '🩺', 'Hospital roster']] : []),
            ['sec-studentrules', '🎯', 'Student rules'],
            ['sec-presentations', '🎤', 'Presentations'],
            ['sec-other', '📝', 'Other conditions'],
          ] as [string, string, string][]
        ).map(([id, icon, label]) => (
          <button key={id} type="button" className="chip jump-chip" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {icon} {t(label)}
          </button>
        ))}
      </nav>
      <fieldset disabled={ro} className="stack">
        <section className="card">
          <h2 id="sec-period">📆 {t('Period')}</h2>
          <div className="row wrap">
            <label>{t("Name")} <input value={draft.title} onChange={(e) => edit((c) => ({ ...c, title: e.target.value }))} />
            </label>
            <label>{t("From")} <input type="date" value={draft.startDate} onChange={(e) => edit((c) => ({ ...c, startDate: e.target.value }))} />
            </label>
            <label>{t("To")} <input type="date" value={draft.endDate} onChange={(e) => edit((c) => ({ ...c, endDate: e.target.value }))} />
            </label>
          </div>
          <label>{t("Holidays")} <span className="muted small">{t("(count as weekend for fairness)")}</span>
            <div className="chips">
              {draft.holidays.map((h) => (
                <span key={h} className="chip">
                  {h}
                  {!ro && (
                    <button type="button" className="x" onClick={() => edit((c) => ({ ...c, holidays: c.holidays.filter((x) => x !== h) }))}>
                      ×
                    </button>
                  )}
                </span>
              ))}
              <input
                type="date"
                min={draft.startDate}
                max={draft.endDate}
                value=""
                onChange={(e) =>
                  e.target.value && edit((c) => ({ ...c, holidays: [...new Set([...c.holidays, e.target.value])].sort() }))
                }
              />
            </div>
          </label>
          <p className="muted small">
            {hospital
              ? t('{d} days · {p} student places · {s} students', { d: days.length, p: positionsPerPeriod, s: shownPeople.length })
              : `${t('{d} days · {p} positions to fill', { d: days.length, p: positionsPerPeriod })}${workers ? ` · ≈${(positionsPerPeriod / workers).toFixed(1)} ${t('per resident/staff')}` : ''}`}
          </p>
        </section>

        <section className="card">
          <h2 id="sec-jobs">🏷️ {hospital ? t('Places (optional)') : t('Jobs')}</h2>
          <p className="muted small">
            {hospital
              ? t('Only if students on the same shift work in different places, e.g. Ward and ER. Otherwise leave this empty.')
              : t('Where people work during a shift, e.g. ER, Ward, OPD, ICU.')}
          </p>
          <div className="chips">
            {draft.jobs.map((j) => (
              <span key={j.id} className="chip edit">
                <input
                  value={j.name}
                  size={Math.max(4, j.name.length)}
                  onChange={(e) => edit((c) => ({ ...c, jobs: c.jobs.map((x) => (x.id === j.id ? { ...x, name: e.target.value } : x)) }))}
                />
                {!ro && (hospital || draft.jobs.length > 1) && (
                  <button
                    type="button"
                    className="x"
                    onClick={() =>
                      edit((c) => ({
                        ...c,
                        jobs: c.jobs.filter((x) => x.id !== j.id),
                        shifts: c.shifts.map((s) => ({ ...s, requirements: s.requirements.map((r) => (r.jobId === j.id ? { ...r, jobId: '' } : r)) })),
                        members: c.members.map((m) => ({
                          ...m,
                          jobs: m.jobs.filter((x) => x !== j.id),
                          ...(m.periods ? { periods: m.periods.filter((p) => p.jobId !== j.id) } : {}),
                        })),
                      }))
                    }
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {!ro && (
              <button
                type="button"
                onClick={() => edit((c) => ({ ...c, jobs: [...c.jobs, { id: uid(), name: `${hospital ? t('Place') : t('Job')} ${c.jobs.length + 1}` }] }))}
              >
                {hospital ? t('➕ Place') : t('➕ Job')}
              </button>
            )}
          </div>
        </section>

        <RosterModeCard draft={draft} edit={edit} ro={ro} />

        <section className="card">
          <h2 id="sec-shifts">🏥 {hospital ? t('Shift slots & student places') : t('Shift slots')}</h2>
          {hospital && (
            <p className="muted small">{t('Name each shift and set how many students it takes. If students on one shift are split between places (e.g. Ward × 1 and ER × 1), add the places above, then a row per place.')}</p>
          )}
          <div className="stack">
            {draft.shifts.map((s) => (
              <div key={s.id} className="shift">
                <div className="row wrap">
                  <label>{t("Name")} <input value={s.name} onChange={(e) => setShift(s.id, (x) => ({ ...x, name: e.target.value }))} />
                  </label>
                  <label>{t("Starts")} <input type="time" value={s.start} onChange={(e) => setShift(s.id, (x) => ({ ...x, start: e.target.value }))} />
                  </label>
                  <label>{t("Ends")} <input type="time" value={s.end} onChange={(e) => setShift(s.id, (x) => ({ ...x, end: e.target.value }))} />
                  </label>
                  <label>
                    {t('Ends on')}
                    <select value={endDays(s)} disabled={ro} onChange={(e) => setShift(s.id, (x) => ({ ...x, endDays: Number(e.target.value) }))}>
                      <option value={0}>{t('the same day')}</option>
                      <option value={1}>{t('the next day')}</option>
                      <option value={2}>{t('2 days later')}</option>
                    </select>
                    <span className="muted small">{t('{h} hours', { h: fmtPoints(shiftHours(s)) })}</span>
                  </label>
                  <div className="weekdays" role="group" aria-label={t("Runs on")}>
                    {ALL_DAYS.map((d) => (
                      <button
                        type="button"
                        key={d}
                        aria-pressed={s.days.includes(d)}
                        className={s.days.includes(d) ? 'day on' : 'day'}
                        onClick={() =>
                          setShift(s.id, (x) => ({
                            ...x,
                            days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d].sort(),
                          }))
                        }
                      >
                        {weekdayLetter()[d]}
                      </button>
                    ))}
                  </div>
                  {!ro && (
                    <button type="button" className="link danger" onClick={() => edit((c) => ({ ...c, shifts: c.shifts.filter((x) => x.id !== s.id) }))}>{t("Remove shift")}</button>
                  )}
                </div>
                <table className="mini">
                  <thead>
                    <tr>
                      {showJobs && <th>{hospital ? t('Place') : t('Job')}</th>}
                      {!hospital && <th>{t("Who")}</th>}
                      <th>{hospital ? t("Students (at least – at most)") : t("How many")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {s.requirements.map((r) => (
                      <tr key={r.id}>
                        {showJobs && (
                          <td>
                            <select value={r.jobId} onChange={(e) => setReq(s.id, r.id, { jobId: e.target.value })}>
                              <option value="">{hospital ? t('Any place') : t('Any job')}</option>
                              {draft.jobs.map((j) => (
                                <option key={j.id} value={j.id}>
                                  {j.name}
                                </option>
                              ))}
                            </select>
                          </td>
                        )}
                        {!hospital && (
                          <td>
                            <select value={r.memberType} onChange={(e) => setReq(s.id, r.id, { memberType: e.target.value as Requirement['memberType'] })}>
                              <option value="resident">{t("Resident")}</option>
                              <option value="staff">{t("Staff")}</option>
                              <option value="any">{t("Anyone")}</option>
                            </select>
                          </td>
                        )}
                        <td className="nowrap">
                          {hospital && (
                            <>
                              <input
                                type="number"
                                min={0}
                                max={r.count}
                                aria-label={t("At least")}
                                title={t("At least")}
                                value={r.min ?? 0}
                                onChange={(e) => setReq(s.id, r.id, { min: Math.min(r.count, Math.max(0, Number(e.target.value) || 0)) })}
                              />{' '}
                              –{' '}
                            </>
                          )}
                          <input
                            type="number"
                            min={1}
                            max={20}
                            aria-label={hospital ? t('At most') : t('How many')}
                            title={hospital ? t('At most') : undefined}
                            value={r.count}
                            onChange={(e) => setReq(s.id, r.id, { count: Math.max(1, Number(e.target.value) || 1) })}
                          />
                        </td>
                        <td>
                          {!ro && s.requirements.length > 1 && (
                            <button
                              type="button"
                              className="x"
                              onClick={() => setShift(s.id, (x) => ({ ...x, requirements: x.requirements.filter((y) => y.id !== r.id) }))}
                            >
                              ×
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!ro && draft.jobs.length > 0 && (
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      setShift(s.id, (x) => ({
                        ...x,
                        requirements: [...x.requirements, { id: uid(), jobId: draft.jobs[0]?.id ?? '', memberType: 'staff', count: 1 }],
                      }))
                    }
                  >{t("➕ Position")}</button>
                )}
              </div>
            ))}
            {!ro && (
              <button
                type="button"
                onClick={() =>
                  edit((c) => ({
                    ...c,
                    shifts: [
                      ...c.shifts,
                      {
                        id: uid(),
                        name: `${t('Shift')} ${c.shifts.length + 1}`,
                        start: '08:00',
                        end: '16:00',
                        days: [1, 2, 3, 4, 5],
                        requirements: [{ id: uid(), jobId: hospital ? '' : (c.jobs[0]?.id ?? ''), memberType: 'resident', count: 1 }],
                      },
                    ],
                  }))
                }
              >{t("➕ Shift slot")}</button>
            )}
          </div>
        </section>

        <CalendarCard draft={draft} edit={edit} ro={ro} />

        <section className="card">
          <h2 id="sec-people">🎓 {hospital ? t('Students') : t('People')}</h2>
          {hospital && (
            <p className="muted small">{t(
                "Only students go here. Residents and staff come from the hospital roster below"
              )} {doctorCount ? ` ${t('({n} names so far)', { n: doctorCount })}` : ''}.
                          </p>
          )}
          {me.isHost && <JoinRequests code={code} session={session} me={me} mutate={mutate} dirty={dirty} />}
          {me.isHost && !IS_DEMO && (
            <p className="muted small">{t(
              "Already added someone? Send them their personal link (in the Login column) — it opens with their name picked, and they set a PIN. People not on the list can ask to join, and appear above for you to approve."
            )}</p>
          )}
          {!ro && (
            <div className="row wrap align-end">
              <label className="grow">
                {hospital ? t("Add students — one name per line") : t("Add people — one name per line")}
                <textarea rows={3} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={hospital ? 'Beam\nPraew' : 'Dr. Ann\nDr. Ben'} />
              </label>
              {!hospital && (
                <select value={bulkType} onChange={(e) => setBulkType(e.target.value as MemberType)}>
                  <option value="resident">{t("as residents")}</option>
                  <option value="staff">{t("as staff")}</option>
                  <option value="student">{t("as students")}</option>
                </select>
              )}
              <button
                type="button"
                disabled={!bulk.trim()}
                onClick={() => {
                  const names = bulk.split('\n').map((n) => n.trim()).filter(Boolean)
                  edit((c) => ({
                    ...c,
                    members: [...c.members, ...names.map((name) => ({ id: uid(), name, type: hospital ? ('student' as const) : bulkType, jobs: [] }))],
                  }))
                  setBulk('')
                }}
              >{t("Add")}</button>
            </div>
          )}
          {shownPeople.length === 0 ? (
            <p className="muted">{t("No one yet.")}</p>
          ) : (
            <div className="scroll-x">
              <table className="mini people">
                <thead>
                  <tr>
                    <th>{t("Name")}</th>
                    {!hospital && <th>{t("Type")}</th>}
                    {draft.jobs.length > 1 && <th>{t("Can cover")}</th>}
                    {draft.rosterMode === 'generate' && <th title={t("Optional hard cap")}>{t("Max shifts")}</th>}
                    <th>{t("Login")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shownPeople.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <input value={m.name} onChange={(e) => setMember(m.id, { name: e.target.value })} />
                      </td>
                      {!hospital && (
                      <td>
                        <select value={m.type} onChange={(e) => setMember(m.id, { type: e.target.value as MemberType })}>
                          <option value="resident">{t("Resident")}</option>
                          <option value="staff">{t("Staff")}</option>
                          <option value="student">{t("Student")}</option>
                        </select>
                      </td>
                      )}
                      {draft.jobs.length > 1 && (
                        <td className="nowrap">
                          {draft.jobs.map((j) => (
                            <label key={j.id} className="check">
                              <input
                                type="checkbox"
                                checked={m.jobs.length === 0 || m.jobs.includes(j.id)}
                                onChange={(e) => {
                                  const cur = m.jobs.length === 0 ? draft.jobs.map((x) => x.id) : m.jobs
                                  const next = e.target.checked ? [...cur, j.id] : cur.filter((x) => x !== j.id)
                                  setMember(m.id, { jobs: next.length === draft.jobs.length ? [] : next })
                                }}
                              />
                              {j.name}
                            </label>
                          ))}
                          <PlacePeriods draft={draft} member={m} ro={ro} set={(periods) => setMember(m.id, { periods: periods.length ? periods : undefined })} />
                        </td>
                      )}
                      {draft.rosterMode === 'generate' && (
                      <td>
                        <input
                          type="number"
                          min={0}
                          placeholder="—"
                          value={m.maxShifts ?? ''}
                          onChange={(e) => setMember(m.id, { maxShifts: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })}
                        />
                      </td>
                      )}
                      <td className="nowrap small">
                        {session.claimed.includes(m.id) ? (
                          <>{t("✓ logged in")}{' '}
                            {!ro && (
                              <ConfirmButton
                                className="link"
                                title={t("Clear their PIN so they can claim their name again")}
                                confirmText={t("tap to reset")}
                                onConfirm={() => void mutate(() => api.resetClaim(code, m.id))}
                              >{t("reset PIN")}</ConfirmButton>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="muted">{t("not yet")}</span>{' '}
                            {me.isHost && !IS_DEMO && <PersonalLink code={code} memberId={m.id} name={m.name} />}
                          </>
                        )}
                      </td>
                      <td>
                        {!ro && (
                          <button type="button" className="x" onClick={() => edit((c) => ({ ...c, members: c.members.filter((x) => x.id !== m.id) }))}>
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {draft.rosterMode === 'hospital' && <DutyRosterCard draft={draft} edit={edit} ro={ro} />}
        <StudentsCard draft={draft} edit={edit} ro={ro} responses={session.responses} />
        <PresentationsCard draft={draft} edit={edit} ro={ro} />

        <section className="card">
          <h2 id="sec-other">📝 {t('Other conditions')}</h2>
          <p className="muted small">{t(
            "Rules the built-in solver can't check, e.g. “Morning round Mon–Fri needs the post-night resident present until 10:00” or “Ann and Ben never on the same night”. The Roster tab turns these into a prompt you can paste into an AI."
          )}</p>
          <textarea
            rows={4}
            value={draft.extraConditions}
            onChange={(e) => edit((c) => ({ ...c, extraConditions: e.target.value }))}
            placeholder={t("One condition per line")}
          />
        </section>
      </fieldset>
      {me.isHost && (
        <div className="savebar">
          {error && <span className="error small">{error}</span>}
          {dirty && session.schedule && <span className="small warn-text">{t("A roster exists — check it after saving.")}</span>}
          <span className="muted small">{dirty ? t("Unsaved changes") : t("All changes saved")}</span>
          {dirty && (
            <button
              onClick={() => setDraft(null)}
            >{t("Discard")}</button>
          )}
          <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? t("Saving…") : t("Save setup")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Dated places: "Ward A from the 1st to the 15th, then Ward B". On those dates they replace the ticks. */
function PlacePeriods({ draft, member, ro, set }: { draft: SessionConfig; member: Member; ro: boolean; set: (p: PlacePeriod[]) => void }) {
  const periods = member.periods ?? []
  const change = (i: number, patch: Partial<PlacePeriod>) => set(periods.map((p, k) => (k === i ? { ...p, ...patch } : p)))
  const add = () => {
    // Carry on from the last one: the next place, starting the day after it ends.
    const last = periods[periods.length - 1]
    const next = draft.jobs[(draft.jobs.findIndex((j) => j.id === last?.jobId) + 1) % draft.jobs.length]
    const from = last && last.to < draft.endDate ? addDays(last.to, 1) : draft.startDate
    set([...periods, { jobId: next.id, from, to: draft.endDate }])
  }
  return (
    <div className="periods">
      {periods.map((p, i) => (
        <div key={i} className="row small nowrap">
          <select value={p.jobId} onChange={(e) => change(i, { jobId: e.target.value })} aria-label={t('Place')}>
            {draft.jobs.map((j) => (
              <option key={j.id} value={j.id}>{j.name}</option>
            ))}
          </select>
          <input type="date" value={p.from} min={draft.startDate} max={draft.endDate} aria-label={t('From')} onChange={(e) => e.target.value && change(i, { from: e.target.value })} />
          –
          <input type="date" value={p.to} min={draft.startDate} max={draft.endDate} aria-label={t('To')} onChange={(e) => e.target.value && change(i, { to: e.target.value })} />
          {p.from > p.to && <span className="error">{t('ends before it starts')}</span>}
          {!ro && (
            <button type="button" className="x" onClick={() => set(periods.filter((_, k) => k !== i))}>
              ×
            </button>
          )}
        </div>
      ))}
      {periods.length > 0 && <span className="muted small">{t('Other dates: the ticked places.')}</span>}
      {!ro && (
        <button type="button" className="link small" title={t('Only this place between two dates, e.g. Ward A for two weeks, then Ward B')} onClick={add}>
          {periods.length ? t('➕ then another place') : t('➕ Place by dates')}
        </button>
      )}
    </div>
  )
}

function PersonalLink({ code, memberId, name }: { code: string; memberId: string; name: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'show'>('idle')
  const url = `${location.origin}${location.pathname}${sessionHash(code)}--${memberId}`
  return (
    <>
      <button
        type="button"
        className="link"
        title={t('A link that opens with {name} picked', { name })}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(t('{name}, fill in your duty availability on Wayneday: {url}', { name, url }))
            setState('copied')
            setTimeout(() => setState('idle'), 1500)
          } catch {
            setState('show')
          }
        }}
      >
        {state === 'copied' ? t("copied!") : t("copy link")}
      </button>
      {state === 'show' && <input readOnly className="invite-url" value={url} onFocus={(e) => e.target.select()} autoFocus />}
    </>
  );
}
