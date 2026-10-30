import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { api } from '../api.ts'
import { exportCsv, exportPng, exportToDrive, exportXlsx, GOOGLE_CLIENT_ID, personTable } from '../export.ts'
import { runSolver } from '../runSolver.ts'
import { buildAiPrompt, importAiResult } from '../shared/ai.ts'
import { shortDate } from '../shared/dates.ts'
import { validate } from '../shared/solver.ts'
import type { Assignment, Schedule } from '../shared/types.ts'
import RosterTable from './RosterTable.tsx'
import type { SessionProps } from './props.ts'

interface Preview {
  assignments: Assignment[]
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

export default function RosterTab({ code, session, me, mutate }: SessionProps) {
  const { config, responses, schedule } = session
  const now = useNow()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [problems, setProblems] = useState<string[] | null>(null)
  const [running, setRunning] = useState(false)
  const [seed, setSeed] = useState(1)
  const [reviewHours, setReviewHours] = useState(48)
  const [edit, setEdit] = useState<Assignment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [concernDate, setConcernDate] = useState('')
  const tableRef = useRef<HTMLDivElement>(null)

  const shown = edit ?? preview?.assignments ?? schedule?.assignments ?? null
  const violations = useMemo(() => (shown ? validate(config, responses, shown) : []), [shown, config, responses])
  const inReview = schedule?.status === 'review' && now < schedule.reviewUntil

  async function simulate() {
    setRunning(true)
    setProblems(null)
    setError(null)
    try {
      const r = await runSolver(config, responses, { seed })
      setSeed((s) => s + 1)
      if (r.ok) {
        setPreview({ assignments: r.assignments, source: 'solver', notes: r.warnings })
      } else {
        setPreview(null)
        setProblems(r.problems)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  async function publish(assignments: Assignment[], source: Schedule['source'], status: Schedule['status']) {
    setError(null)
    try {
      const t = Date.now()
      await mutate(() =>
        api.saveSchedule(code, { status, assignments, generatedAt: t, reviewUntil: t + reviewHours * 3_600_000, source }),
      )
      setPreview(null)
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
            <button className="primary" disabled={running} onClick={() => void simulate()}>
              {running ? 'Simulating…' : preview ? 'Simulate again (new variant)' : 'Simulate'}
            </button>
            {preview && (
              <>
                <label className="inline">
                  Concern period
                  <input type="number" min={0} max={720} value={reviewHours} onChange={(e) => setReviewHours(Math.max(0, Number(e.target.value)))} />
                  hours
                </label>
                <button className="primary" onClick={() => void publish(preview.assignments, preview.source, 'review')}>
                  Publish for review
                </button>
                <button onClick={() => setPreview(null)}>Discard preview</button>
              </>
            )}
          </div>
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
              Previewing a {preview.source === 'ai' ? 'AI-made' : 'simulated'} roster — nobody else can see it until you publish.
              {preview.notes.map((n) => (
                <span key={n} className="block">
                  {n}
                </span>
              ))}
            </p>
          )}
          <AiPanel {...{ code, session, me, mutate }} onImport={(a, notes) => {
            setPreview({ assignments: a, source: 'ai', notes })
            setProblems(null)
          }} />
        </section>
      )}

      {schedule && !preview && (
        <section className={`card status ${schedule.status}`}>
          {schedule.status === 'final' ? (
            <p>
              <strong>Final roster.</strong> Published {new Date(schedule.generatedAt).toLocaleString()}.
            </p>
          ) : inReview ? (
            <p>
              <strong>In review</strong> — raise concerns for the next {duration(schedule.reviewUntil - now)} (until{' '}
              {new Date(schedule.reviewUntil).toLocaleString()}).
            </p>
          ) : (
            <p>
              <strong>Review period ended.</strong> {me.isHost ? 'Address the concerns, then finalize.' : 'Waiting for the host to finalize.'}
            </p>
          )}
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
                <button onClick={() => setEdit(schedule.assignments)}>Edit cells</button>
              ) : (
                <>
                  <button className="primary" onClick={() => void publish(edit, 'manual', schedule.status)}>
                    Save edits
                  </button>
                  <button onClick={() => setEdit(null)}>Cancel edits</button>
                </>
              )}
              <button
                className="link danger"
                onClick={() => confirm('Delete the published roster? Answers stay.') && void mutate(() => api.saveSchedule(code, null))}
              >
                Delete roster
              </button>
            </div>
          )}
        </section>
      )}

      {error && <p className="error">{error}</p>}

      {!shown ? (
        <p className="muted">{me.isHost ? 'Simulate to preview a roster.' : 'The host hasn’t published a roster yet.'}</p>
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
              assignments={shown}
              myId={me.memberId}
              concerns={session.concerns}
              tableRef={tableRef}
              onPick={
                !edit && !preview && inReview && me.memberId
                  ? (date) => {
                      setConcernDate(date)
                      document.getElementById('concern-text')?.focus()
                    }
                  : undefined
              }
              onEdit={
                edit
                  ? (date, shiftId, requirementId, slot, memberId) =>
                      setEdit((cur) => {
                        const list = cur ?? []
                        const here = list.filter((a) => a.date === date && a.shiftId === shiftId && a.requirementId === requirementId)
                        const target = here[slot]
                        const rest = list.filter((a) => a !== target)
                        return memberId ? [...rest, { date, shiftId, requirementId, memberId }] : rest
                      })
                  : undefined
              }
            />
          </section>
          <Exports {...{ code, session, me, mutate }} assignments={shown} tableRef={tableRef} />
          <Stats {...{ code, session, me, mutate }} assignments={shown} />
        </>
      )}

      {schedule && <Concerns {...{ code, session, me, mutate }} open={inReview} date={concernDate} setDate={setConcernDate} />}
    </div>
  )
}

function AiPanel({ session, onImport }: SessionProps & { onImport: (a: Assignment[], notes: string[]) => void }) {
  const [open, setOpen] = useState(Boolean(session.config.extraConditions.trim()))
  const [reply, setReply] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const prompt = useMemo(() => buildAiPrompt(session.config, session.responses, session.schedule), [session])
  const hasExtra = Boolean(session.config.extraConditions.trim())

  return (
    <details className="ai" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        Use an AI {hasExtra ? <span className="badge warn">you have other conditions</span> : <span className="muted small">(optional)</span>}
      </summary>
      {hasExtra && (
        <p className="small">
          The built-in solver can’t check your “other conditions”. Copy this prompt into ChatGPT, Claude or Gemini, then paste the reply
          below — it’s checked against the hard rules before you can publish.
        </p>
      )}
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
          setMsg(`Imported ${r.assignments.length} assignments.`)
          onImport(r.assignments, r.skipped.length ? [`Skipped ${r.skipped.length} rows that didn’t match: ${r.skipped.slice(0, 5).join('; ')}`] : [])
        }}
      >
        Import reply as preview
      </button>
    </details>
  )
}

function Exports({ session, assignments, tableRef }: SessionProps & { assignments: Assignment[]; tableRef: RefObject<HTMLDivElement | null> }) {
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
        <button onClick={run(() => exportXlsx(session.config, session.responses, assignments))}>Excel (.xlsx)</button>
        <button onClick={run(() => exportCsv(session.config, assignments))}>CSV</button>
        <button onClick={run(async () => {
          const table = tableRef.current?.querySelector('table')
          if (table) await exportPng(table, session.config)
        })}>Image (.png)</button>
        <button
          disabled={!GOOGLE_CLIENT_ID}
          title={GOOGLE_CLIENT_ID ? '' : 'Set VITE_GOOGLE_CLIENT_ID to enable — or upload the .xlsx to Drive yourself'}
          onClick={run(async () => {
            const url = await exportToDrive(session.config, assignments)
            setMsg({ text: 'Saved to Google Drive.', url })
          })}
        >
          Google Sheets (Drive)
        </button>
      </div>
      {!GOOGLE_CLIENT_ID && <p className="muted small">Drive export isn’t configured on this server — download the .xlsx and open it in Google Drive.</p>}
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

function Stats({ session, me, assignments }: SessionProps & { assignments: Assignment[] }) {
  const t = personTable(session.config, session.responses, assignments)
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
