import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { api } from '../api.ts'
import { googleClientId } from '../google.ts'
import { t } from '../shared/i18n.ts'
import { exportCsv, exportPng, exportToDrive, exportXlsx, personTable } from '../export.ts'
import { findArrangements, rearrangeStudents } from '../runSolver.ts'
import { buildAiPrompt, importAiResult } from '../shared/ai.ts'
import { shortDate } from '../shared/dates.ts'
import { reqCount } from '../shared/calendar.ts'
import { validate, type CountResult } from '../shared/solver.ts'
import {
  pickPresenters,
  placeKey,
  studentCellIssues,
  studentExposure,
  studentRuleReport,
  studentSummaryTable,
  studentTargets,
  type StudentOption,
} from '../shared/students.ts'
import { dutyOf, STUDENT_SLOT, type MemberResponse, type Roster, type Schedule, type SessionConfig, type StudentAssignment } from '../shared/types.ts'
import CalendarExport from './CalendarExport.tsx'
import ConfirmButton from './ConfirmButton.tsx'
import type { Explanation } from '../shared/explain.ts'
import RosterTable, { type Arrange } from './RosterTable.tsx'
import Swaps, { type SwapDraft } from './Swaps.tsx'
import type { SessionProps } from './props.ts'

interface Preview {
  roster: Roster
  source: Schedule['source']
  notes: string[]
  /** The roster as the option/AI produced it, before the host moved students by hand. */
  base?: Roster
}

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

function duration(ms: number) {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? t('{d}d {h}h', { d: Math.floor(h / 24), h: h % 24 }) : t('{h}h {m}m', { h, m })
}

const rosterOf = (s: Schedule): Roster => ({ assignments: s.assignments, students: s.students, presenters: s.presenters })

function countText(c: CountResult, shown: number): string {
  if (c.exact) {
    if (c.count === 0) return t('No possible arrangement.')
    return c.count <= shown
      ? t('There are exactly {n} possible arrangement(s) — all shown below.', { n: c.count.toLocaleString() })
      : t('There are exactly {n} possible arrangements. Showing the {k} best.', { n: c.count.toLocaleString(), k: shown })
  }
  // A very tight setup can defeat the random estimate; then all we know is that the options shown exist.
  if (!Number.isFinite(c.log10) || 10 ** c.log10 < shown * 2) {
    return t('There are at least {k} possible arrangements — too many combinations to count exactly. Showing the {k} best distinct ones.', { k: shown })
  }
  const approx = t('about {n}', { n: c.log10 < 15 ? Number((10 ** c.log10).toPrecision(2)).toLocaleString() : `10^${Math.round(c.log10)}` })
  return t('There are {approx} possible arrangements (estimated — too many to list). Showing the {k} best distinct ones.', { approx, k: shown })
}

/** One-line fairness summary of a roster, for comparing options. */
function summary(config: SessionConfig, roster: Roster, responses: Record<string, MemberResponse>): string {
  const parts: string[] = []
  const isWeekend = (d: string) => [0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()) || config.holidays.includes(d)
  if (config.rosterMode === 'generate') {
    for (const type of ['resident', 'staff'] as const) {
      const ids = config.members.filter((m) => m.type === type).map((m) => m.id)
      if (!ids.length) continue
      const totals = ids.map((id) => roster.assignments.filter((a) => a.memberId === id).length)
      parts.push(t(type === 'resident' ? 'Residents {a}–{b}' : 'Staff {a}–{b}', { a: Math.min(...totals), b: Math.max(...totals) }))
    }
    const workers = config.members.filter((m) => m.type !== 'student').map((m) => m.id)
    const wk = workers.map((id) => roster.assignments.filter((a) => a.memberId === id && isWeekend(a.date)).length)
    if (wk.length) parts.push(t('weekends {a}–{b}', { a: Math.min(...wk), b: Math.max(...wk) }))
  } else {
    const ids = config.members.filter((m) => m.type === 'student').map((m) => m.id)
    const wk = ids.map((id) => roster.students.filter((s) => s.memberId === id && isWeekend(s.date)).length)
    if (wk.length && wk.some((n) => n > 0)) parts.push(t('student weekends {a}–{b}', { a: Math.min(...wk), b: Math.max(...wk) }))
    parts.push(...studentRuleReport(config, responses, roster).summary)
  }
  if (roster.students.length) {
    const exp = studentExposure(config, roster.assignments, roster.students)
    for (const type of ['resident', 'staff'] as const) {
      const xs = config.members.filter((m) => m.type === type).map((m) => exp[m.id] ?? 0)
      if (xs.some((x) => x > 0)) {
        parts.push(t(type === 'resident' ? 'students with residents {a}–{b}' : 'students with staff {a}–{b}', { a: Math.min(...xs), b: Math.max(...xs) }))
      }
    }
  }
  return parts.join(' · ')
}

/** Positions held by a different person than in `a`. */
function differs(a: Roster, b: Roster): number {
  const key = (x: { date: string; shiftId: string; requirementId?: string; memberId: string }) => `${x.date}|${x.shiftId}|${x.requirementId ?? ''}|${x.memberId}`
  const inA = new Set([...a.assignments, ...a.students].map(key))
  return [...b.assignments, ...b.students].filter((x) => !inA.has(key(x))).length
}

export default function RosterTab({ code, session, me, mutate }: SessionProps) {
  const { config, responses, schedule } = session
  const now = useNow()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [options, setOptions] = useState<StudentOption[] | null>(null)
  const [count, setCount] = useState<CountResult | null>(null)
  const [problems, setProblems] = useState<string[] | null>(null)
  const [explain, setExplain] = useState<Explanation | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [seed, setSeed] = useState(1)
  const [reviewHours, setReviewHours] = useState(48)
  const [edit, setEdit] = useState<Roster | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [concernDate, setConcernDate] = useState('')
  const [swapDraft, setSwapDraft] = useState<SwapDraft | null>(null)
  const [picked, setPicked] = useState<StudentAssignment | null>(null)
  const [history, setHistory] = useState<Roster[]>([])
  const tableRef = useRef<HTMLDivElement>(null)

  const shown: Roster | null = edit ?? preview?.roster ?? (schedule ? rosterOf(schedule) : null)
  const violations = useMemo(() => (shown ? validate(config, responses, shown) : []), [shown, config, responses])
  const inReview = schedule?.status === 'review' && now < schedule.reviewUntil
  const hasStudents = config.members.some((m) => m.type === 'student')
  const hospital = config.rosterMode === 'hospital'
  // Hospital mode: the published roster should carry the hospital roster as it now stands in Setup.
  const dutyKey = (xs: { date: string; shiftId: string; requirementId: string; memberId: string }[]) =>
    xs.map((a) => `${a.date}|${a.shiftId}|${a.requirementId}|${a.memberId}`).sort().join(',')
  const dutyChanged = hospital && schedule !== null && dutyKey(schedule.assignments) !== dutyKey(dutyOf(config))

  async function find() {
    setRunning('find')
    setProblems(null)
    setExplain(null)
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
        setProblems(r.result.ok ? [t('No arrangement found.')] : r.result.problems)
        setExplain(r.explain ?? null)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(null)
    }
  }

  async function studentsOnly() {
    if (!shown) return
    setRunning('students')
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
      const at = Date.now()
      await mutate(() =>
        api.saveSchedule(code, {
          status,
          ...roster,
          generatedAt: at,
          reviewUntil: keepReview && schedule ? schedule.reviewUntil : at + reviewHours * 3_600_000,
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

  // ---- hand-arranging students in the preview ----
  const canArrange = me.isHost && preview !== null && !edit && hasStudents
  const placeOf = (x: StudentAssignment) => ({ date: x.date, shiftId: x.shiftId, ...(x.requirementId ? { requirementId: x.requirementId } : {}) })
  function applyStudents(next: StudentAssignment[]) {
    if (!preview) return
    setHistory((h) => [...h, preview.roster])
    const presenters = pickPresenters(config, responses, preview.roster.assignments, next).presenters
    setPreview({ ...preview, base: preview.base ?? preview.roster, roster: { ...preview.roster, students: next, presenters } })
    setPicked(null)
  }
  function swapStudents(a: StudentAssignment, b: StudentAssignment) {
    applyStudents(
      preview!.roster.students.map((x) => (x === a ? { ...x, ...placeOf(b), memberId: a.memberId } : x === b ? { ...x, ...placeOf(a), memberId: b.memberId } : x)),
    )
  }
  const arrange: Arrange | undefined = (() => {
    if (!canArrange || !preview) return undefined
    const students = preview.roster.students
    const base = preview.base ?? preview.roster
    const sig = (xs: StudentAssignment[]) => {
      const m = new Map<string, string[]>()
      for (const x of xs) m.set(placeKey(x), [...(m.get(placeKey(x)) ?? []), x.memberId].sort())
      return m
    }
    const before = sig(base.students)
    const after = sig(students)
    const changed = new Set([...before.keys(), ...after.keys()].filter((k) => (before.get(k) ?? []).join() !== (after.get(k) ?? []).join()))
    const targets = picked ? studentTargets(config, responses, students, picked) : { moves: new Set<string>(), swaps: new Set<string>() }
    return {
      picked,
      moves: targets.moves,
      swaps: targets.swaps,
      issues: studentCellIssues(config, responses, students),
      changed,
      onChip: (x) => {
        if (!picked) setPicked(x)
        else if (picked === x) setPicked(null)
        else swapStudents(picked, x)
      },
      onPlace: (date, shiftId, requirementId) => {
        if (!picked) return
        const here = students.filter((x) => x.date === date && x.shiftId === shiftId && (x.requirementId ?? '') === (requirementId ?? ''))
        const shift = config.shifts.find((x) => x.id === shiftId)
        const req = shift?.requirements.find((r) => r.id === requirementId)
        const cap = shift && req ? reqCount(config, shift, req, date) : config.students.maxPerShift
        if (here.length >= cap && here[0]) return swapStudents(picked, here[0])
        applyStudents(students.map((x) => (x === picked ? { ...x, date, shiftId, ...(requirementId ? { requirementId } : {}) } : x)))
      },
    }
  })()

  const missingAnswers = config.members.filter((m) => !responses[m.id] && (!hospital || m.type === 'student'))
  // Until everyone has pressed "I'm ready!", finding arrangements is a practice run.
  const answering = config.members.filter((m) => !hospital || m.type === 'student')
  const notReady = answering.filter((m) => !responses[m.id]?.ready)
  const practice = notReady.length > 0
  const pick = (date: string, shiftId: string, requirementId: string | null) => {
    const mineHere =
      requirementId &&
      (requirementId === STUDENT_SLOT
        ? schedule?.students.some((a) => a.memberId === me.memberId && a.date === date && a.shiftId === shiftId)
        : schedule?.assignments.some((a) => a.memberId === me.memberId && a.date === date && a.shiftId === shiftId && a.requirementId === requirementId))
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
          <h2>✨ {hospital ? t('Arrange students') : t('Generate')}</h2>
          {hospital && (
            config.noDuty ? (
              <p className="muted small">{t('The hospital roster is left blank, so students are arranged on their own.')}</p>
            ) : (
            <p className="muted small">{t("Residents and staff come from the hospital roster you entered in Setup (")}{config.duty.length} {t("shifts). Wayneday arranges the students")} {config.presentations.length ? t(" and presenters") : ''} {t("around it.")}</p>
            )
          )}
          {hospital && !config.noDuty && config.duty.length === 0 && (
            <p className="small warn-text">{t('Enter the hospital roster in Setup first, or mark it as left blank there.')}</p>
          )}
          {practice && (
            <div className="alert practice" role="status">
              <strong>🧪 {t('Practice run — {r} of {n} ready', { r: answering.length - notReady.length, n: answering.length })}</strong>
              <p className="small">
                {t('Not everyone has pressed “I’m ready!”, so arrangements found now are just to try things out — answers can still change.')}{' '}
                {t('Waiting on: {names}.', { names: notReady.map((m) => m.name).join(', ') })}
                {missingAnswers.length > 0 && ` ${t('{n} haven’t answered at all and get the default preferences.', { n: missingAnswers.length })}`}
              </p>
            </div>
          )}
          <div className="row wrap">
            <button className="primary" disabled={running !== null || (hospital && !config.noDuty && config.duty.length === 0)} onClick={() => void find()}>
              {running === 'find'
                ? `⏳ ${t('Finding arrangements…')}`
                : options
                  ? `🔄 ${t('Find different arrangements')}`
                  : practice
                    ? `🧪 ${t('Try arrangements (practice)')}`
                    : `✨ ${t('Find arrangements')}`}
            </button>
            {!hospital && hasStudents && shown && (
              <button disabled={running !== null} onClick={() => void studentsOnly()} title={t("Keep residents and staff exactly as they are")}>
                {running === 'students' ? `⏳ ${t('Arranging students…')}` : `🎲 ${t('Re-arrange students & presenters only')}`}
              </button>
            )}
          </div>
          {count && options && <p className="small count-line">{countText(count, options.length)}</p>}
          {options && options.length > 0 && (
            <div className="options" role="radiogroup" aria-label={t("Arrangements")}>
              {options.map((o, i) => {
                const on = (preview?.base ?? preview?.roster) === o.roster
                return (
                  <button
                    key={o.id}
                    role="radio"
                    aria-checked={on}
                    className={`option ${on ? 'on' : ''}`}
                    onClick={() => {
                      setPreview({ roster: o.roster, source: 'solver', notes: o.warnings })
                      setPicked(null)
                      setHistory([])
                      setEdit(null)
                    }}
                  >
                    <strong>{t("Option")} {i + 1}
                      {i === 0 ? t(" · fairest") : ''}
                    </strong>
                    <span className="small muted">{summary(config, o.roster, responses)}</span>
                    {i > 0 && <span className="small">{differs(options[0].roster, o.roster)} {t("shifts differ from option 1")}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {preview && (
            <div className="row wrap">
              <label className="inline">{t("Concern period")} <input type="number" min={0} max={720} value={reviewHours} onChange={(e) => setReviewHours(Math.max(0, Number(e.target.value)))} /> {t("hours")}</label>
              {practice ? (
                <ConfirmButton
                  title={t('Not everyone is ready yet')}
                  confirmText={t('tap again to publish anyway')}
                  onConfirm={() => void publish(preview.roster, preview.source, 'review')}
                >
                  {t('📢 Publish anyway ({n} not ready)', { n: notReady.length })}
                </ConfirmButton>
              ) : (
                <button className="primary" onClick={() => void publish(preview.roster, preview.source, 'review')}>{t("📢 Publish for review")}</button>
              )}
              <button
                onClick={() => {
                  setPreview(null)
                  setOptions(null)
                }}
              >{t("Discard preview")}</button>
            </div>
          )}
          {problems && (
            <div className="alert">
              <strong>{t("No possible arrangement.")}</strong>
              {explain && explain.hints.length > 0 ? (
                <>
                  <p className="small">{t('Why it doesn’t fit, and what to change:')}</p>
                  <ul className="hints">
                    {explain.hints.map((h) => (
                      <li key={h.why}>
                        {h.why}
                        <span className="block small">💡 {h.fix}</span>
                      </li>
                    ))}
                  </ul>
                  {explain.wouldWork.length > 0 && (
                    <p className="small">
                      ✅ <b>{t('It would work with any one of these:')}</b> {explain.wouldWork.join(' · ')}
                    </p>
                  )}
                </>
              ) : (
                <ul>
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {preview && (
            <p className="muted small">{t("Previewing a")} {preview.source === 'ai' ? t("AI-made") : preview.source === 'manual' ? t("edited") : t("generated")} {t("roster — nobody else sees it until you publish.")} {preview.notes.map((n) => (
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
              <strong>{t("Final roster.")}</strong> {t("Published")} {new Date(schedule.generatedAt).toLocaleString()}{t(". Swaps still go through the host.")}</p>
          ) : inReview ? (
            <p>
              <strong>{t("In review")}</strong> {t("— raise concerns or ask for swaps for the next")} {duration(schedule.reviewUntil - now)} {t("(until")}{' '}
              {new Date(schedule.reviewUntil).toLocaleString()}).
                          </p>
          ) : (
            <p>
              <strong>{t("Review period ended.")}</strong> {me.isHost ? t("Address the concerns, then finalize.") : t("Waiting for the host to finalize.")}
            </p>
          )}
          {me.memberId && <p className="muted small">{t("Tap one of your own shifts to ask for a swap")}{inReview ? t(", or any other cell to raise a concern about that date") : ''}.</p>}
          {me.isHost && (
            <div className="row wrap">
              {schedule.status === 'review' && (
                <button className="primary" onClick={() => void setStatus({ status: 'final' })}>{t("✅ Finalize")}</button>
              )}
              {schedule.status === 'review' && (
                <button onClick={() => void setStatus({ reviewUntil: Math.max(now, schedule.reviewUntil) + 24 * 3_600_000 })}>{t("⏳ Extend review 24h")}</button>
              )}
              {schedule.status === 'final' && (
                <button onClick={() => void setStatus({ status: 'review', reviewUntil: now + 24 * 3_600_000 })}>{t("Reopen for review")}</button>
              )}
              {!edit ? (
                <button onClick={() => setEdit(rosterOf(schedule))}>{hospital ? t("Edit students") : t("Edit cells")}</button>
              ) : (
                <>
                  <button className="primary" onClick={() => void publish(edit, 'manual', schedule.status, true)}>{t("💾 Save edits")}</button>
                  <button onClick={() => setEdit(null)}>{t("Cancel edits")}</button>
                </>
              )}
              <ConfirmButton
                className="link danger"
                confirmText={t("Tap again to delete (answers stay)")}
                onConfirm={() => void mutate(() => api.saveSchedule(code, null))}
              >{t("Delete roster")}</ConfirmButton>
            </div>
          )}
        </section>
      )}
      {error && <p className="error">{error}</p>}
      {me.isHost && dutyChanged && !preview && (
        <div className="alert warn">{t("The hospital roster in Setup has changed since you published.")}{' '}
          <button onClick={() => void publish({ ...rosterOf(schedule!), assignments: dutyOf(config) }, 'manual', schedule!.status, true)}>{t("Use the new hospital roster")}</button>{' '}
          <span className="small">{t(
            "(students stay where they are — find arrangements again if they should move)"
          )}</span>
        </div>
      )}
      {schedule && !preview && <Swaps {...{ code, session, me, mutate }} draft={swapDraft} clearDraft={() => setSwapDraft(null)} />}
      {!shown ? (
        <p className="muted">{me.isHost ? t("Tap “Find arrangements” to see the possible rosters.") : t("The host hasn’t published a roster yet.")}</p>
      ) : (
        <>
          {violations.length > 0 && (
            <div className="alert warn">
              <strong>{violations.length} {t("rule")} {violations.length === 1 ? t("issue") : t("issues")}</strong>
              <ul>
                {violations.slice(0, 12).map((v) => (
                  <li key={v}>{v}</li>
                ))}
                {violations.length > 12 && <li>{t("…and")} {violations.length - 12} {t("more")}</li>}
              </ul>
            </div>
          )}
          {arrange && (
            <div className="arrange-bar" role="status">
              <span className="small">
                {picked
                  ? t('Moving {name}: green places and outlined names keep every rule. Tap a place or a student; tap them again to cancel.', {
                      name: config.members.find((m) => m.id === picked.memberId)?.name ?? '',
                    })
                  : t(
                  "Tap a student to move or swap them. Red places break a rule (tap or hover for why)."
                )}
              </span>
              <span className="row">
                {arrange.changed.size > 0 && <span className="small muted">{arrange.changed.size} {t("place(s) changed")}</span>}
                <button
                  disabled={history.length === 0}
                  onClick={() => {
                    const prev = history[history.length - 1]
                    setHistory((h) => h.slice(0, -1))
                    if (prev && preview) setPreview({ ...preview, roster: prev })
                    setPicked(null)
                  }}
                >{t("↶ Undo")}</button>
                {preview?.base && (
                  <button
                    onClick={() => {
                      setHistory([])
                      setPreview({ ...preview, roster: preview.base!, base: undefined })
                      setPicked(null)
                    }}
                  >{t("Back to option")}</button>
                )}
              </span>
            </div>
          )}
          <section className="card flush">
            <RosterTable
              arrange={arrange}
              config={config}
              roster={shown}
              myId={me.memberId}
              concerns={session.concerns}
              swaps={session.swaps}
              tableRef={tableRef}
              onPick={!edit && !preview && me.memberId ? pick : undefined}
              onEditStudent={
                edit && hasStudents
                  ? (date, shiftId, slot, memberId, requirementId) =>
                      setEdit((cur) => {
                        const list = cur?.students ?? []
                        const here = list.filter((x) => x.date === date && x.shiftId === shiftId && x.requirementId === requirementId)
                        const target = here[slot]
                        const rest = list.filter((x) => x !== target)
                        return { ...cur!, students: memberId ? [...rest, { date, shiftId, ...(requirementId ? { requirementId } : {}), memberId }] : rest }
                      })
                  : undefined
              }
              onEdit={
                edit && !hospital
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
          {config.presentations.length > 0 && <p className="muted small">{t("● = presenting after being on the previous night’s shift.")}</p>}
          {hasStudents && <RulesCheck config={config} responses={responses} roster={shown} />}
          <Exports {...{ code, session, me, mutate }} roster={shown} tableRef={tableRef} />
          {hasStudents && <StudentSummary config={config} roster={shown} myId={me.memberId} />}
          {!hospital && <Stats {...{ code, session, me, mutate }} roster={shown} />}
        </>
      )}
      {schedule && <Concerns {...{ code, session, me, mutate }} open={inReview} date={concernDate} setDate={setConcernDate} />}
    </div>
  );
}

function AiPanel({ session, roster, onImport }: SessionProps & { roster: Roster | null; onImport: (r: Roster, notes: string[]) => void }) {
  const [open, setOpen] = useState(Boolean(session.config.extraConditions.trim()))
  const [reply, setReply] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const prompt = useMemo(() => buildAiPrompt(session.config, session.responses, roster), [session.config, session.responses, roster])
  const hasExtra = Boolean(session.config.extraConditions.trim())

  return (
    <details className="ai" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{t("Use an AI")} {hasExtra ? <span className="badge warn">{t("you have other conditions")}</span> : <span className="muted small">{t("(optional)")}</span>}
      </summary>
      <p className="small">
        {hasExtra ? t("The built-in solver can’t check your “other conditions”. ") : ''} {t("Copy this prompt into ChatGPT, Claude or Gemini. It includes")} {roster ? t("the roster you’re looking at") : t("everyone’s answers")} {t(
          "and asks the AI to reply in Wayneday’s format. Paste the whole reply below; it’s checked against the hard rules before you can publish."
        )}</p>
      <div className="row wrap">
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(prompt)
              setMsg(t('Prompt copied.'))
            } catch {
              setMsg(t('Select the text below and copy it.'))
            }
          }}
        >{t("🤖 Copy AI prompt")}</button>
        <span className="muted small">{msg}</span>
      </div>
      <textarea readOnly rows={6} value={prompt} className="mono small" onFocus={(e) => e.target.select()} />
      <label>{t("Paste the AI’s reply")} <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t("{\"assignments\": [...]}")} />
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
            t('Imported {a} shifts, {s} student shifts, {p} presenters.', { a: r.roster.assignments.length, s: r.roster.students.length, p: r.roster.presenters.length }),
          )
          onImport(r.roster, r.skipped.length ? [t('Skipped {n} rows that didn’t match: {rows}', { n: r.skipped.length, rows: r.skipped.slice(0, 5).join('; ') })] : [])
        }}
      >{t("📥 Import reply as preview")}</button>
    </details>
  );
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
      <h2>📤 {t('Export')}</h2>
      <div className="row wrap">
        <button onClick={run(() => exportXlsx(session.config, session.responses, roster))}>{t("📊 Excel (.xlsx)")}</button>
        <button onClick={run(() => exportCsv(session.config, roster))}>{t("🧾 CSV")}</button>
        <button onClick={run(async () => {
          const table = tableRef.current?.querySelector('table')
          if (table) await exportPng(table, session.config)
        })}>{t("🖼️ Image (.png)")}</button>
        <button
          disabled={!googleClientId()}
          title={googleClientId() ? '' : t('Not set up on this server — upload the .xlsx to Drive yourself')}
          onClick={run(async () => {
            const url = await exportToDrive(session.config, roster)
            setMsg({ text: t('Saved to Google Drive.'), url })
          })}
        >{t("☁️ Google Sheets (Drive)")}</button>
      </div>
      {!googleClientId() && <p className="muted small">{t(
        "Drive export isn’t configured on this server — download the .xlsx and open it in Google Drive."
      )}</p>}
      <CalendarExport {...props} />
      {msg && (
        <p className="small">
          {msg.text}{' '}
          {msg.url && (
            <a href={msg.url} target="_blank" rel="noreferrer">{t("Open sheet")}</a>
          )}
        </p>
      )}
    </section>
  );
}

function Stats({ session, me, roster }: SessionProps & { roster: Roster }) {
  const table = personTable(session.config, session.responses, roster)
  return (
    <section className="card">
      <h2>👥 {t('Per person')}</h2>
      <div className="scroll-x">
        <table className="mini">
          <thead>
            <tr>
              {table.header.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
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
  const name = (id: string) => (id === 'host' ? t('Host') : (session.config.members.find((m) => m.id === id)?.name ?? '?'))
  const canPost = me.isHost || (open && me.memberId)
  const list = [...session.concerns].sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.createdAt - a.createdAt)

  return (
    <section className="card">
      <h2>
        💬 {t('Concerns')}{' '}
        {session.concerns.filter((c) => !c.resolved).length > 0 && (
          <span className="badge warn">{t('{n} open', { n: session.concerns.filter((c) => !c.resolved).length })}</span>
        )}
      </h2>
      {canPost && me.memberId && <p className="muted small">{t("Tip: tap a cell in the roster to raise a concern about that date.")}</p>}
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
            <label className="grow">{t("Your concern")} <input id="concern-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("e.g. Can I swap my 12th night with someone? I have an exam.")} required />
            </label>
            <label>{t("About date")} <span className="muted small">{t("(optional)")}</span>
              <input type="date" min={session.config.startDate} max={session.config.endDate} value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <button className="primary">{t("💬 Post")}</button>
          </div>
          {error && <span className="error small">{error}</span>}
        </form>
      ) : (
        <p className="muted small">{me.memberId ? t("The concern period is closed.") : t("Log in to raise a concern.")}</p>
      )}
      {list.length === 0 ? (
        <p className="muted small">{t("No concerns raised.")}</p>
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
                  {c.resolved ? t("Reopen") : t("Mark resolved")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RulesCheck({ config, responses, roster }: { config: SessionConfig; responses: Record<string, MemberResponse>; roster: Roster }) {
  const r = studentRuleReport(config, responses, roster)
  if (!r.summary.length) return null
  const ok = r.details.length === 0
  return (
    <section className={`card rules-check ${ok ? 'ok' : ''}`}>
      <h2>{ok ? '✅' : '⚠️'} {t('Rules check')}</h2>
      <p className="small">{r.summary.join(' · ')}</p>
      {!ok && (
        <ul className="small">
          {r.details.slice(0, 15).map((d) => (
            <li key={d}>{d}</li>
          ))}
          {r.details.length > 15 && <li>{t("…and")} {r.details.length - 15} {t("more")}</li>}
        </ul>
      )}
    </section>
  );
}

function StudentSummary({ config, roster, myId }: { config: SessionConfig; roster: Roster; myId: string | null }) {
  const table = studentSummaryTable(config, roster)
  const students = config.members.filter((m) => m.type === 'student')
  return (
    <section className="card">
      <h2>🎓 {t('Per student')}</h2>
      <div className="scroll-x">
        <table className="mini">
          <thead>
            <tr>
              {table.header.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={students[i].id} className={students[i].id === myId ? 'me' : ''}>
                {r.map((v, j) => (
                  <td key={j} className={j >= 2 && (j - 2) % 6 === 0 ? 'nowrap' : ''}>
                    {j >= 2 && (j - 2) % 6 === 0 && v ? shortDate(v) : v}
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
