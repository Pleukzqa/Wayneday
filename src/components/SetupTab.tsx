import { useMemo, useState } from 'react'
import { api } from '../api.ts'
import { addDays, dateRange, WEEKDAYS } from '../shared/dates.ts'
import type { Member, MemberType, Requirement, SessionConfig, ShiftSlot } from '../shared/types.ts'
import { IS_DEMO, sessionHash } from '../routes.ts'
import { reqCount } from '../shared/calendar.ts'
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
  const ward = { id: uid(), name: 'Ward' }
  return {
    ...c,
    startDate: start,
    endDate: end,
    jobs: [ward],
    shifts: [
      {
        id: uid(),
        name: 'Night',
        start: '16:00',
        end: '08:00',
        days: ALL_DAYS,
        requirements: [{ id: uid(), jobId: ward.id, memberType: 'resident', count: 1 }],
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

  return (
    <div className="stack">
      {ro && <p className="muted">Only the host can change the setup. This is what they've configured.</p>}
      <fieldset disabled={ro} className="stack">
        <section className="card">
          <h2>Period</h2>
          <div className="row wrap">
            <label>
              Name
              <input value={draft.title} onChange={(e) => edit((c) => ({ ...c, title: e.target.value }))} />
            </label>
            <label>
              From
              <input type="date" value={draft.startDate} onChange={(e) => edit((c) => ({ ...c, startDate: e.target.value }))} />
            </label>
            <label>
              To
              <input type="date" value={draft.endDate} onChange={(e) => edit((c) => ({ ...c, endDate: e.target.value }))} />
            </label>
          </div>
          <label>
            Holidays <span className="muted small">(count as weekend for fairness)</span>
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
            {days.length} days · {positionsPerPeriod} positions to fill
            {workers ? ` · ≈${(positionsPerPeriod / workers).toFixed(1)} per resident/staff` : ''}
          </p>
        </section>

        <section className="card">
          <h2>Jobs</h2>
          <p className="muted small">Where people work during a shift, e.g. ER, Ward, OPD, ICU.</p>
          <div className="chips">
            {draft.jobs.map((j) => (
              <span key={j.id} className="chip edit">
                <input
                  value={j.name}
                  size={Math.max(4, j.name.length)}
                  onChange={(e) => edit((c) => ({ ...c, jobs: c.jobs.map((x) => (x.id === j.id ? { ...x, name: e.target.value } : x)) }))}
                />
                {!ro && draft.jobs.length > 1 && (
                  <button
                    type="button"
                    className="x"
                    onClick={() =>
                      edit((c) => ({
                        ...c,
                        jobs: c.jobs.filter((x) => x.id !== j.id),
                        shifts: c.shifts.map((s) => ({ ...s, requirements: s.requirements.filter((r) => r.jobId !== j.id) })),
                        members: c.members.map((m) => ({ ...m, jobs: m.jobs.filter((x) => x !== j.id) })),
                      }))
                    }
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {!ro && (
              <button type="button" onClick={() => edit((c) => ({ ...c, jobs: [...c.jobs, { id: uid(), name: `Job ${c.jobs.length + 1}` }] }))}>
                + Job
              </button>
            )}
          </div>
        </section>

        <section className="card">
          <h2>Shift slots</h2>
          <div className="stack">
            {draft.shifts.map((s) => (
              <div key={s.id} className="shift">
                <div className="row wrap">
                  <label>
                    Name
                    <input value={s.name} onChange={(e) => setShift(s.id, (x) => ({ ...x, name: e.target.value }))} />
                  </label>
                  <label>
                    Starts
                    <input type="time" value={s.start} onChange={(e) => setShift(s.id, (x) => ({ ...x, start: e.target.value }))} />
                  </label>
                  <label>
                    Ends
                    <input type="time" value={s.end} onChange={(e) => setShift(s.id, (x) => ({ ...x, end: e.target.value }))} />
                  </label>
                  <div className="weekdays" role="group" aria-label="Runs on">
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
                        {WEEKDAYS[d][0]}
                      </button>
                    ))}
                  </div>
                  {!ro && (
                    <button type="button" className="link danger" onClick={() => edit((c) => ({ ...c, shifts: c.shifts.filter((x) => x.id !== s.id) }))}>
                      Remove shift
                    </button>
                  )}
                </div>
                <table className="mini">
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Who</th>
                      <th>How many</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {s.requirements.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <select value={r.jobId} onChange={(e) => setReq(s.id, r.id, { jobId: e.target.value })}>
                            {draft.jobs.map((j) => (
                              <option key={j.id} value={j.id}>
                                {j.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select value={r.memberType} onChange={(e) => setReq(s.id, r.id, { memberType: e.target.value as Requirement['memberType'] })}>
                            <option value="resident">Resident</option>
                            <option value="staff">Staff</option>
                            <option value="any">Anyone</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            min={1}
                            max={20}
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
                        requirements: [...x.requirements, { id: uid(), jobId: draft.jobs[0].id, memberType: 'staff', count: 1 }],
                      }))
                    }
                  >
                    + Position
                  </button>
                )}
              </div>
            ))}
            {!ro && (
              <button
                type="button"
                disabled={draft.jobs.length === 0}
                onClick={() =>
                  edit((c) => ({
                    ...c,
                    shifts: [
                      ...c.shifts,
                      {
                        id: uid(),
                        name: `Shift ${c.shifts.length + 1}`,
                        start: '08:00',
                        end: '16:00',
                        days: [1, 2, 3, 4, 5],
                        requirements: [{ id: uid(), jobId: c.jobs[0].id, memberType: 'resident', count: 1 }],
                      },
                    ],
                  }))
                }
              >
                + Shift slot
              </button>
            )}
          </div>
        </section>

        <CalendarCard draft={draft} edit={edit} ro={ro} />
        <RosterModeCard draft={draft} edit={edit} ro={ro} />

        <section className="card">
          <h2>People</h2>
          {me.isHost && <JoinRequests code={code} session={session} me={me} mutate={mutate} dirty={dirty} />}
          {me.isHost && !IS_DEMO && (
            <p className="muted small">
              Already added someone? Send them their personal link (in the Login column) — it opens with their name picked, and they set a PIN.
              People not on the list can ask to join, and appear above for you to approve.
            </p>
          )}
          {!ro && (
            <div className="row wrap align-end">
              <label className="grow">
                Add people — one name per line
                <textarea rows={3} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'Dr. Ann\nDr. Ben'} />
              </label>
              <select value={bulkType} onChange={(e) => setBulkType(e.target.value as MemberType)}>
                <option value="resident">as residents</option>
                <option value="staff">as staff</option>
                <option value="student">as students</option>
              </select>
              <button
                type="button"
                disabled={!bulk.trim()}
                onClick={() => {
                  const names = bulk.split('\n').map((n) => n.trim()).filter(Boolean)
                  edit((c) => ({
                    ...c,
                    members: [...c.members, ...names.map((name) => ({ id: uid(), name, type: bulkType, jobs: [] }))],
                  }))
                  setBulk('')
                }}
              >
                Add
              </button>
            </div>
          )}
          {draft.members.length === 0 ? (
            <p className="muted">No one yet.</p>
          ) : (
            <div className="scroll-x">
              <table className="mini people">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    {draft.jobs.length > 1 && <th>Can cover</th>}
                    {draft.rosterMode === 'generate' && <th title="Optional hard cap">Max shifts</th>}
                    <th>Login</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.members.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <input value={m.name} onChange={(e) => setMember(m.id, { name: e.target.value })} />
                      </td>
                      <td>
                        <select value={m.type} onChange={(e) => setMember(m.id, { type: e.target.value as MemberType })}>
                          <option value="resident">Resident</option>
                          <option value="staff">Staff</option>
                          <option value="student">Student</option>
                        </select>
                      </td>
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
                          <>
                            ✓ logged in{' '}
                            {!ro && (
                              <ConfirmButton
                                className="link"
                                title="Clear their PIN so they can claim their name again"
                                confirmText="tap to reset"
                                onConfirm={() => void mutate(() => api.resetClaim(code, m.id))}
                              >
                                reset PIN
                              </ConfirmButton>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="muted">not yet</span>{' '}
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
        <StudentsCard draft={draft} edit={edit} ro={ro} />
        <PresentationsCard draft={draft} edit={edit} ro={ro} />

        <section className="card">
          <h2>Other conditions</h2>
          <p className="muted small">
            Rules the built-in solver can't check, e.g. “Morning round Mon–Fri needs the post-night resident present until 10:00” or
            “Ann and Ben never on the same night”. The Roster tab turns these into a prompt you can paste into an AI.
          </p>
          <textarea
            rows={4}
            value={draft.extraConditions}
            onChange={(e) => edit((c) => ({ ...c, extraConditions: e.target.value }))}
            placeholder="One condition per line"
          />
        </section>
      </fieldset>

      {me.isHost && (
        <div className="savebar">
          {error && <span className="error small">{error}</span>}
          {dirty && session.schedule && <span className="small warn-text">A roster exists — check it after saving.</span>}
          <span className="muted small">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          {dirty && (
            <button
              onClick={() => setDraft(null)}
            >
              Discard
            </button>
          )}
          <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save setup'}
          </button>
        </div>
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
        title={`A link that opens with ${name} picked`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`${name}, fill in your duty availability on Wayneday: ${url}`)
            setState('copied')
            setTimeout(() => setState('idle'), 1500)
          } catch {
            setState('show')
          }
        }}
      >
        {state === 'copied' ? 'copied!' : 'copy link'}
      </button>
      {state === 'show' && <input readOnly className="invite-url" value={url} onFocus={(e) => e.target.select()} autoFocus />}
    </>
  )
}
