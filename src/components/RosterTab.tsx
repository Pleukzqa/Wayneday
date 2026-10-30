import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { api } from '../api.ts'
import { exportCsv, exportPng, exportToDrive, exportXlsx, GOOGLE_CLIENT_ID, personTable } from '../export.ts'
import { findArrangements, rearrangeStudents } from '../runSolver.ts'
import { buildAiPrompt, importAiResult } from '../shared/ai.ts'
import { shortDate } from '../shared/dates.ts'
import { validate, type Alternative, type CountResult } from '../shared/solver.ts'
import { studentExposure } from '../shared/students.ts'
import type { Roster, Schedule, SessionConfig } from '../shared/types.ts'
import CalendarExport from './CalendarExport.tsx'
import ConfirmButton from './ConfirmButton.tsx'
import RosterTable from './RosterTable.tsx'
import Swaps, { type SwapDraft } from './Swaps.tsx'
import type { SessionProps } from './props.ts'

interface Preview {
  roster: Roster
  source: Schedule['source']
  notes: string[]
}

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function duration(ms: number) {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`
}

const rosterOf = (s: Schedule): Roster => ({ assignments: s.assignments, students: s.students, presenters: s.presenters })

function countText(c: CountResult, shown: number): string {
  if (c.exact) {
    if (c.count === 0) return 'No possible arrangement.'
    return c.count <= shown
      ? `There ${c.count === 1 ? 'is exactly 1 possible arrangement' : `are exactly ${c.count.toLocaleString()} possible arrangements`} — all shown below.`
      : `There are exactly ${c.count.toLocaleString()} possible arrangements. Showing the ${shown} best.`
  }
  const approx = c.log10 < 15 ? `about ${Number((10 ** c.log10).toPrecision(2)).toLocaleString()}` : `about 10^${Math.round(c.log10)}`
  return `There are ${approx} possible arrangements (estimated — too many to list). Showing the ${shown} best distinct ones.`
}

/** One-line fairness summary of a roster, for comparing options. */
function summary(config: SessionConfig, roster: Roster): string {
  const parts: string[] = []
  for (const type of ['resident', 'staff'] as const) {
    const ids = config.members.filter((m) => m.type === type).map((m) => m.id)
    if (!ids.length) continue
    const totals = ids.map((id) => roster.assignments.filter((a) => a.memberId === id).length)
    parts.push(`${type === 'resident' ? 'Residents' : 'Staff'} ${Math.min(...totals)}–${Math.max(...totals)}`)
  }
  const workers = config.members.filter((m) => m.type !== 'student').map((m) => m.id)
  const wk = workers.map(
    (id) => roster.assignments.filter((a) => a.memberId === id && ([0, 6].includes(new Date(a.date + 'T00:00:00Z').getUTCDay()) || config.holidays.includes(a.date))).length,
  )
  if (wk.length) parts.push(`weekends ${Math.min(...wk)}–${Math.max(...wk)}`)
  if (roster.students.length) {
    const exp = studentExposure(config, roster.assignments, roster.students)
    for (const type of ['resident', 'staff'] as const) {
      const xs = config.members.filter((m) => m.type === type).map((m) => exp[m.id] ?? 0)
      if (xs.some((x) => x > 0)) parts.push(`students with ${type === 'resident' ? 'residents' : 'staff'} ${Math.min(...xs)}–${Math.max(...xs)}`)
    }
  }
  return parts.join(' · ')
}

/** Positions held by a different person than in `a`. */
function differs(a: Roster, b: Roster): number {
  const key = (x: { date: string; shiftId: string; requirementId: string; memberId: string }) => `${x.date}|${x.shiftId}|${x.requirementId}|${x.memberId}`
  const inA = new Set(a.assignments.map(key))
  return b.assignments.filter((x) => !inA.has(key(x))).length
}

export default function RosterTab({ code, session, me, mutate }: SessionProps) {
  const { config, responses, schedule } = session
  const now = useNow()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [options, setOptions] = useState<Alternative[] | null>(null)
  const [count, setCount] = useState<CountResult | null>(null)
  const [problems, setProblems] = useState<string[] | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [seed, setSeed] = useState(1)
  const [reviewHours, setReviewHours] = useState(48)
  const [edit, setEdit] = useState<Roster | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [concernDate, setConcernDate] = useState('')
  const [swapDraft, setSwapDraft] = useState<SwapDraft | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)

  const shown: Roster | null = edit ?? preview?.roster ?? (schedule ? rosterOf(schedule) : null)
  const violations = useMemo(() => (shown ? validate(config, responses, shown) : []), [shown, config, responses])
  const inReview = schedule?.status === 'review' && now < schedule.reviewUntil
  const hasStudents = config.members.some((m) => m.type === 'student')

  async function find() {
    setRunning('Finding arrangements…')
    setProblems(null)
    setError(null)
    try {
      const r = await findArrangements(config, responses, seed)
      setSeed((s) => s + 1000)
      if (r.result.ok && r.result.alternatives.length) {
        setOptions(r.result.alternatives)
        setCount(r.count)
        const best = r.result.alternatives[0]
        setPreview({ roster: best.roster, source: 'solver', notes: best.warnings })
      } else {
        setOptions(null)
        setCount(null)
        setPreview(null)
        setProblems(r.result.ok ? ['No arrangement found.'] : r.result.problems)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(null)
    }
  }

  async function studentsOnly() {
    if (!shown) return
    setRunning('Arranging students…')
    setError(null)
    try {
      const r = await rearrangeStudents(config, responses, shown.assignments, seed)
      setSeed((s) => s + 1)
      if (!r.ok) setProblems(r.problems)
      else {
        setProblems(null)
        setPreview({ roster: { assignments: shown.assignments, students: r.students, presenters: r.presenters }, source: preview?.source ?? 'manual', notes: r.warnings })
        setEdit(null)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(null)
    }
  }

  async function publish(roster: Roster, source: Schedule['source'], status: Schedule['status'], keepReview = false) {
    setError(null)
    try {
      const t = Date.now()
      await mutate(() =>
        api.saveSchedule(code, {
          status,
          ...roster,
          generatedAt: t,
          reviewUntil: keepReview && schedule ? schedule.reviewUntil : t + reviewHours * 3_600_000,
          source,
        }),
      )
      setPreview(null)
      setOptions(null)
      setEdit(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function setStatus(patch: Partial<Schedule>) {
    if (!schedule) return
    try {
      await mutate(() => api.saveSchedule(code, { ...schedule, ...patch }))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const missingAnswers = config.members.filter((m) => !responses[m.id])
  const pick = (date: string, shiftId: string, requirementId: string | null) => {
    const mineHere =
      requirementId &&
      schedule?.assignments.some((a) => a.memberId === me.memberId && a.date === date && a.shiftId === shiftId && a.requirementId === requirementId)
    if (mineHere && requirementId) {
      setSwapDraft({ date, shiftId, requirementId })
      document.getElementById('swaps')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (inReview) {
      setConcernDate(date)
      document.getElementById('concern-text')?.focus()
    }
  }

  return (
    <div className="stack">
      {me.isHost && (
        <section className="card">
          <h2>Generate</h2>
          {missingAnswers.length > 0 && (
            <p className="muted small">
              Waiting on {missingAnswers.length}: {missingAnswers.map((m) => m.name).join(', ')}. They’ll get default preferences if you
              generate now.
            </p>
          )}
          <div className="row wrap">
            <button className="primary" disabled={running !== null} onClick={() => void find()}>
              {running?.startsWith('Finding') ? running : options ? 'Find different arrangements' : 'Find arrangements'}
            </button>
            {hasStudents && shown && (
              <button disabled={running !== null} onClick={() => void studentsOnly()} title="Keep residents and staff exactly as they are">
                {running?.startsWith('Arranging') ? running : 'Re-arrange students & presenters only'}
              </button>
            )}
          </div>
          {count && options && <p className="small count-line">{countText(count, options.length)}</p>}
          {options && options.length > 0 && (
            <div className="options" role="radiogroup" aria-label="Arrangements">
              {options.map((o, i) => {
                const on = preview?.roster === o.roster
                return (
                  <button
                    key={o.id}
                    role="radio"
                    aria-checked={on}
                    className={`option ${on ? 'on' : ''}`}
                    onClick={() => {
                      setPreview({ roster: o.roster, source: 'solver', notes: o.warnings })
                      setEdit(null)
                    }}
                  >
                    <strong>
                      Option {i + 1}
                      {i === 0 ? ' · fairest' : ''}
                    </strong>
                    <span className="small muted">{summary(config, o.roster)}</span>
                    {i > 0 && <span className="small">{differs(options[0].roster, o.roster)} shifts differ from option 1</span>}
                  </button>
                )
              })}
            </div>
          )}
          {preview && (
            <div className="row wrap">
              <label className="inline">
                Concern period
                <input type="number" min={0} max={720} value={reviewHours} onChange={(e) => setReviewHours(Math.max(0, Number(e.target.value)))} />
                hours
              </label>
              <button className="primary" onClick={() => void publish(preview.roster, preview.source, 'review')}>
                Publish for review
              </button>
              <button
                onClick={() => {
                  setPreview(null)
                  setOptions(null)
                }}
              >
                Discard preview
              </button>
            </div>
          )}
          {problems && (
            <div className="alert">
              <strong>No possible arrangement.</strong>
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {preview && (
            <p className="muted small">
              Previewing a {preview.source === 'ai' ? 'AI-made' : preview.source === 'manual' ? 'edited' : 'generated'} roster — nobody else sees it until
              you publish.
              {preview.notes.map((n) => (
                <span key={n} className="block">
                  {n}
                </span>
              ))}
            </p>
          )}
          <AiPanel
            {...{ code, session, me, mutate }}
            roster={shown}
            onImport={(r, notes) => {
              setPreview({ roster: r, source: 'ai', notes })
              setOptions(null)
              setProblems(null)
            }}
          />
        </section>
      )}

      {schedule && !preview && (
        <section className={`card status ${schedule.status}`}>
          {schedule.status === 'final' ? (
            <p>
              <strong>Final roster.</strong> Published {new Date(schedule.generatedAt).toLocaleString()}. Swaps still go through the host.
            </p>
          ) : inReview ? (
            <p>
              <strong>In review</strong> — raise concerns or ask for swaps for the next {duration(schedule.reviewUntil - now)} (until{' '}
              {new Date(schedule.reviewUntil).toLocaleString()}).
            </p>
          ) : (
            <p>
              <strong>Review period ended.</strong> {me.isHost ? 'Address the concerns, then finalize.' : 'Waiting for the host to finalize.'}
            </p>
          )}
          {me.memberId && <p className="muted small">Tap one of your own shifts to ask for a swap{inReview ? ', or any other cell to raise a concern about that date' : ''}.</p>}
          {me.isHost && (
            <div className="row wrap">
              {schedule.status === 'review' && (
                <button className="primary" onClick={() => void setStatus({ status: 'final' })}>
                  Finalize
                </button>
              )}
              {schedule.status === 'review' && (
                <button onClick={() => void setStatus({ reviewUntil: Math.max(now, schedule.reviewUntil) + 24 * 3_600_000 })}>
                  Extend review 24h
                </button>
              )}
              {schedule.status === 'final' && (
                <button onClick={() => void setStatus({ status: 'review', reviewUntil: now + 24 * 3_600_000 })}>Reopen for review</button>
              )}
              {!edit ? (
                <button onClick={() => setEdit(rosterOf(schedule))}>Edit cells</button>
              ) : (
                <>
                  <button className="primary" onClick={() => void publish(edit, 'manual', schedule.status, true)}>
                    Save edits
                  </button>
                  <button onClick={() => setEdit(null)}>Cancel edits</button>
                </>
              )}
              <ConfirmButton
                className="link danger"
                confirmText="Tap again to delete (answers stay)"
                onConfirm={() => void mutate(() => api.saveSchedule(code, null))}
              >
                Delete roster
              </ConfirmButton>
            </div>
          )}
        </section>
      )}

      {error && <p className="error">{error}</p>}

      {schedule && !preview && <Swaps {...{ code, session, me, mutate }} draft={swapDraft} clearDraft={() => setSwapDraft(null)} />}

      {!shown ? (
        <p className="muted">{me.isHost ? 'Tap “Find arrangements” to see the possible rosters.' : 'The host hasn’t published a roster yet.'}</p>
      ) : (
        <>
          {violations.length > 0 && (
            <div className="alert warn">
              <strong>{violations.length} rule {violations.length === 1 ? 'issue' : 'issues'}</strong>
              <ul>
                {violations.slice(0, 12).map((v) => (
                  <li key={v}>{v}</li>
                ))}
                {violations.length > 12 && <li>…and {violations.length - 12} more</li>}
              </ul>
            </div>
          )}
          <section className="card flush">
            <RosterTable
              config={config}
              roster={shown}
              myId={me.memberId}
              concerns={session.concerns}
              swaps={session.swaps}
              tableRef={tableRef}
              onPick={!edit && !preview && me.memberId ? pick : undefined}
              onEdit={
                edit
                  ? (date, shiftId, requirementId, slot, memberId) =>
                      setEdit((cur) => {
                        const list = cur?.assignments ?? []
                        const here = list.filter((a) => a.date === date && a.shiftId === shiftId && a.requirementId === requirementId)
                        const target = here[slot]
                        const rest = list.filter((a) => a !== target)
                        return { ...cur!, assignments: memberId ? [...rest, { date, shiftId, requirementId, memberId }] : rest }
                      })
                  : undefined
              }
            />
          </section>
          {config.presentations.length > 0 && <p className="muted small">● = presenting after being on the previous night’s shift.</p>}
          <Exports {...{ code, session, me, mutate }} roster={shown} tableRef={tableRef} />
          <Stats {...{ code, session, me, mutate }} roster={shown} />
        </>
      )}

      {schedule && <Concerns {...{ code, session, me, mutate }} open={inReview} date={concernDate} setDate={setConcernDate} />}
    </div>
  )
}

function AiPanel({ session, roster, onImport }: SessionProps & { roster: Roster | null; onImport: (r: Roster, notes: string[]) => void }) {
  const [open, setOpen] = useState(Boolean(session.config.extraConditions.trim()))
  const [reply, setReply] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const prompt = useMemo(() => buildAiPrompt(session.config, session.responses, roster), [session.config, session.responses, roster])
  const hasExtra = Boolean(session.config.extraConditions.trim())

  return (
    <details className="ai" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        Use an AI {hasExtra ? <span className="badge warn">you have other conditions</span> : <span className="muted small">(optional)</span>}
      </summary>
      <p className="small">
        {hasExtra ? 'The built-in solver can’t check your “other conditions”. ' : ''}
        Copy this prompt into ChatGPT, Claude or Gemini. It includes {roster ? 'the roster you’re looking at' : 'everyone’s answers'} and asks the AI to
        reply in Wayneday’s format. Paste the whole reply below; it’s checked against the hard rules before you can publish.
      </p>
      <div className="row wrap">
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(prompt)
              setMsg('Prompt copied.')
            } catch {
              setMsg('Select the text below and copy it.')
            }
          }}
        >
          Copy AI prompt
        </button>
        <span className="muted small">{msg}</span>
      </div>
      <textarea readOnly rows={6} value={prompt} className="mono small" onFocus={(e) => e.target.select()} />
      <label>
        Paste the AI’s reply
        <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder='{"assignments": [...]}' />
      </label>
      <button
        disabled={!reply.trim()}
        onClick={() => {
          const r = importAiResult(reply, session.config)
          if (!r.ok) {
            setMsg(r.error)
            return
          }
          setMsg(
            `Imported ${r.roster.assignments.length} shifts${r.roster.students.length ? `, ${r.roster.students.length} student shifts` : ''}${r.roster.presenters.length ? `, ${r.roster.presenters.length} presenters` : ''}.`,
          )
          onImport(r.roster, r.skipped.length ? [`Skipped ${r.skipped.length} rows that didn’t match: ${r.skipped.slice(0, 5).join('; ')}`] : [])
        }}
      >
        Import reply as preview
      </button>
    </details>
  )
}

function Exports(props: SessionProps & { roster: Roster; tableRef: RefObject<HTMLDivElement | null> }) {
  const { session, roster, tableRef } = props
  const [msg, setMsg] = useState<{ text: string; url?: string } | null>(null)
  const run = (fn: () => Promise<unknown> | void) => async () => {
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg({ text: (e as Error).message })
    }
  }
  return (
    <section className="card">
      <h2>Export</h2>
      <div className="row wrap">
        <button onClick={run(() => exportXlsx(session.config, session.responses, roster))}>Excel (.xlsx)</button>
        <button onClick={run(() => exportCsv(session.config, roster))}>CSV</button>
        <button onClick={run(async () => {
          const table = tableRef.current?.querySelector('table')
          if (table) await exportPng(table, session.config)
        })}>Image (.png)</button>
        <button
          disabled={!GOOGLE_CLIENT_ID}
          title={GOOGLE_CLIENT_ID ? '' : 'Set VITE_GOOGLE_CLIENT_ID to enable — or upload the .xlsx to Drive yourself'}
          onClick={run(async () => {
            const url = await exportToDrive(session.config, roster)
            setMsg({ text: 'Saved to Google Drive.', url })
          })}
        >
          Google Sheets (Drive)
        </button>
      </div>
      {!GOOGLE_CLIENT_ID && <p className="muted small">Drive export isn’t configured on this server — download the .xlsx and open it in Google Drive.</p>}
      <CalendarExport {...props} />
      {msg && (
        <p className="small">
          {msg.text}{' '}
          {msg.url && (
            <a href={msg.url} target="_blank" rel="noreferrer">
              Open sheet
            </a>
          )}
        </p>
      )}
    </section>
  )
}

function Stats({ session, me, roster }: SessionProps & { roster: Roster }) {
  const t = personTable(session.config, session.responses, roster)
  return (
    <section className="card">
      <h2>Per person</h2>
      <div className="scroll-x">
        <table className="mini">
          <thead>
            <tr>
              {t.header.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <tr key={session.config.members[i].id} className={session.config.members[i].id === me.memberId ? 'me' : ''}>
                {r.map((v, j) => (
                  <td key={j} className={j === r.length - 1 ? 'small dates' : ''}>
                    {j === r.length - 1 ? v.split(' ').filter(Boolean).map(shortDate).join(', ') : v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Concerns({
  code,
  session,
  me,
  mutate,
  open,
  date,
  setDate,
}: SessionProps & { open: boolean; date: string; setDate: (d: string) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const name = (id: string) => (id === 'host' ? 'Host' : (session.config.members.find((m) => m.id === id)?.name ?? '?'))
  const canPost = me.isHost || (open && me.memberId)
  const list = [...session.concerns].sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.createdAt - a.createdAt)

  return (
    <section className="card">
      <h2>Concerns {session.concerns.filter((c) => !c.resolved).length > 0 && <span className="badge warn">{session.concerns.filter((c) => !c.resolved).length} open</span>}</h2>
      {canPost && me.memberId && <p className="muted small">Tip: tap a cell in the roster to raise a concern about that date.</p>}
      {canPost ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault()
            setError(null)
            try {
              await mutate(() => api.addConcern(code, text, date || undefined))
              setText('')
              setDate('')
            } catch (err) {
              setError((err as Error).message)
            }
          }}
        >
          <div className="row wrap align-end">
            <label className="grow">
              Your concern
              <input id="concern-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Can I swap my 12th night with someone? I have an exam." required />
            </label>
            <label>
              About date <span className="muted small">(optional)</span>
              <input type="date" min={session.config.startDate} max={session.config.endDate} value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <button className="primary">Post</button>
          </div>
          {error && <span className="error small">{error}</span>}
        </form>
      ) : (
        <p className="muted small">{me.memberId ? 'The concern period is closed.' : 'Log in to raise a concern.'}</p>
      )}
      {list.length === 0 ? (
        <p className="muted small">No concerns raised.</p>
      ) : (
        <ul className="concerns">
          {list.map((c) => (
            <li key={c.id} className={c.resolved ? 'resolved' : ''}>
              <div>
                <strong>{name(c.memberId)}</strong>
                {c.date && <span className="badge">{shortDate(c.date)}</span>}
                <span className="muted tiny"> {new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <p>{c.text}</p>
              {me.isHost && (
                <button className="link" onClick={() => void mutate(() => api.resolveConcern(code, c.id, !c.resolved))}>
                  {c.resolved ? 'Reopen' : 'Mark resolved'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
