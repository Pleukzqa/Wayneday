import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { api, type SessionView } from '../api.ts'
import { googleClientId } from '../google.ts'
import { t } from '../shared/i18n.ts'
import { exportCsv, exportPng, exportToDrive, exportXlsx, personTable } from '../export.ts'
import { findArrangements, rearrangeStudents, repairInBackground, type RepairResult } from '../runSolver.ts'
import { buildAiPrompt, importAiResult } from '../shared/ai.ts'
import { addDays, changeableFrom, shortDate } from '../shared/dates.ts'
import { fmtPoints, reqCount, ruleSources, sourceMatches } from '../shared/calendar.ts'
import { responseFor, validate, type CountResult } from '../shared/solver.ts'
import {
  avoidLevel,
  pickPresenters,
  placeKey,
  polishPresenters,
  rosterAlerts,
  studentCellIssues,
  studentExposure,
  studentRuleReport,
  studentDetails,
  typeSpread,
  fairnessReport,
  shareGroups,
  studentTargets,
  type StudentOption,
} from '../shared/students.ts'
import { dutyOf, isOneDay, personHue, STUDENT_SLOT, type Concern, type MemberResponse, type Roster, type SavedArrangement, type Schedule, type SessionConfig, type StudentAssignment } from '../shared/types.ts'
import { MOST_SAVED } from '../shared/ops.ts'
import CalendarExport from './CalendarExport.tsx'
import ConfirmButton from './ConfirmButton.tsx'
import FeedbackCard from './Feedback.tsx'
import Expandable from './Expandable.tsx'
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
  /** Which arrangement this is: "Option 3", a saved one's name, "AI reply"… */
  name?: string
  /** The saved arrangement it was opened from. */
  savedId?: string
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

const rosterOf = (s: Schedule): Roster => ({ assignments: s.assignments, students: s.students, presenters: s.presenters, ...(s.pinned ? { pinned: s.pinned } : {}) })

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

/**
 * What the host found while arranging, kept per roster while the page is open: the tab unmounts when you
 * switch to another one, and coming back should show the same options (the chosen one is also saved as a draft).
 */
const kept = new Map<
  string,
  { preview: Preview | null; options: StudentOption[] | null; count: CountResult | null; problems: string[] | null; explain: Explanation | null; seed: number }
>()

export default function RosterTab({ code, session, me, mutate }: SessionProps) {
  const { config, responses, schedule } = session
  const now = useNow()
  // The arrangement being tried out comes back from the server (hosts only), so it's here every time.
  const [preview, setPreview] = useState<Preview | null>(() => {
    if (!me.isHost) return null
    // The very one shown before switching tabs (so its option stays picked), else the saved draft.
    const before = kept.get(code)?.preview
    if (before && session.draft) return before
    return session.draft ? { roster: session.draft.roster, source: session.draft.source, notes: session.draft.notes, name: session.draft.name } : null
  })
  const savedDraft = useRef<Preview | null>(preview)
  const latestPreview = useRef<Preview | null>(preview)
  const saveDraft = useCallback(
    (p: Preview | null) => {
      savedDraft.current = p
      void mutate(() => api.saveDraft(code, p ? { roster: p.roster, source: p.source, notes: p.notes, name: p.name } : null)).catch(() => {})
    },
    [code, mutate],
  )
  useEffect(() => {
    latestPreview.current = preview
    if (!me.isHost || preview === savedDraft.current) return
    const timer = setTimeout(() => saveDraft(preview), 600)
    return () => clearTimeout(timer)
  }, [preview, me.isHost, saveDraft])
  // Leaving the tab before the save fires: save now.
  useEffect(
    () => () => {
      if (me.isHost && latestPreview.current !== savedDraft.current) saveDraft(latestPreview.current)
    },
    [me.isHost, saveDraft],
  )
  const [options, setOptions] = useState<StudentOption[] | null>(() => kept.get(code)?.options ?? null)
  const [count, setCount] = useState<CountResult | null>(() => kept.get(code)?.count ?? null)
  const [problems, setProblems] = useState<string[] | null>(() => kept.get(code)?.problems ?? null)
  const [explain, setExplain] = useState<Explanation | null>(() => kept.get(code)?.explain ?? null)
  const [running, setRunning] = useState<string | null>(null)
  const [seed, setSeed] = useState(() => kept.get(code)?.seed ?? 1)
  useEffect(() => {
    kept.set(code, { preview, options, count, problems, explain, seed })
  }, [code, preview, options, count, problems, explain, seed])
  const [reviewHours, setReviewHours] = useState(48)
  const [edit, setEdit] = useState<Roster | null>(null)
  // A proposed change to look at before applying: 🔧 Fix with fewest changes, or 🎤 Even out presenters.
  const [repair, setRepair] = useState<(RepairResult & { kind: 'fix' | 'even' }) | null>(null)
  // The fixes never change today or earlier; tomorrow only when the host unticks this.
  const [keepTomorrow, setKeepTomorrow] = useState(true)
  // Hosts: tapping students and presenters in the table locks them in place (📌).
  const [lockMode, setLockMode] = useState(false)
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
        setPreview({ roster: best.roster, source: 'solver', notes: best.warnings, name: t('Option {n}', { n: 1 }) })
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
        setPreview({ roster: { assignments: shown.assignments, students: r.students, presenters: r.presenters }, source: preview?.source ?? 'manual', notes: r.warnings, name: t('Students re-arranged') })
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

  /** Lock or unlock one slot of the published roster (📌). */
  function toggleLock(key: string) {
    if (!schedule) return
    const next = new Set(schedule.pinned ?? [])
    if (next.has(key)) next.delete(key)
    else next.add(key)
    void mutate(() => api.saveSchedule(code, { ...schedule, pinned: [...next] })).catch((e) => setError((e as Error).message))
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
                : options || preview
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
                      setPreview({ roster: o.roster, source: 'solver', notes: o.warnings, name: t('Option {n}', { n: i + 1 }) })
                      setPicked(null)
                      setHistory([])
                      setEdit(null)
                    }}
                  >
                    <strong>{t("Option")} {i + 1}
                      {i === 0 ? ` · ${t('best fit')}` : ''}
                    </strong>
                    {(() => {
                      // Satisfies both: points within the limit and no !!! request missed.
                      const r = studentRuleReport(config, responses, o.roster)
                      return r.pointsOk && r.avoidHits[3] === 0 ? <span className="small both-ok">✅ {t('fair points · no !!! missed')}</span> : null
                    })()}
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
              <SaveForLater
                count={session.saved?.length ?? 0}
                save={(name) => mutate(() => api.saveArrangement(code, name, { roster: preview.roster, source: preview.source, notes: preview.notes }))}
              />
            </div>
          )}
          {problems && (
            <div className="alert">
              <strong>{t("No possible arrangement.")}</strong>
              {explain && explain.hints.length > 0 ? (
                <>
                  <p className="small">
                    <b>
                      {explain.freeWorks
                        ? `🗓️ ${t('With nobody’s days marked it would work — so it’s the ✕ unavailable days or locked shifts that make it impossible.')}`
                        : `⚙️ ${t('Even if nobody had marked any day, there would be no arrangement — the setup itself doesn’t fit (places, minimums, shifts each or gaps).')}`}
                    </b>
                  </p>
                  <p className="small">{t('Why it doesn’t fit, and what to change:')}</p>
                  <ul className="hints">
                    {explain.hints.map((h) => (
                      <li key={h.why}>
                        {h.why}
                        <span className="block small">💡 {h.fix}</span>
                      </li>
                    ))}
                  </ul>
                  {explain.wouldWork.length > 0 ? (
                    <p className="small">
                      ✅ <b>{t('It would work with any one of these:')}</b> {explain.wouldWork.join(' · ')}
                    </p>
                  ) : (
                    <p className="small muted">{t('No single change is enough here — it needs a few of the fixes above together.')}</p>
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
            <p className="muted small">{t("Previewing a")} {preview.source === 'ai' ? t("AI-made") : preview.source === 'manual' ? t("edited") : t("generated")} {t("roster — nobody else sees it until you publish.")} {t('It’s kept for you and your co-hosts, so it’s still here next time.')} {preview.notes.map((n) => (
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
              setPreview({ roster: r, source: 'ai', notes, name: t('AI reply') })
              setOptions(null)
              setProblems(null)
            }}
          />
        </section>
      )}
      {me.isHost && (session.saved?.length ?? 0) > 0 && (
        <SavedArrangements
          config={config}
          responses={responses}
          saved={session.saved ?? []}
          open={(x) => {
            setEdit(null)
            const opened = { roster: x.roster, source: x.source, notes: x.notes, name: x.name, savedId: x.id }
            setPreview(opened)
            // Kept as the draft straight away, so a reload shows it too.
            saveDraft(opened)
            setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
          }}
          remove={(id) => void mutate(() => api.removeArrangement(code, id)).catch((e) => setError((e as Error).message))}
          openId={preview?.savedId}
        />
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
                <>
                  <button onClick={() => setEdit(rosterOf(schedule))}>{hospital ? (config.presentations.length ? t('Edit students & presenters') : t('Edit students')) : t('Edit cells')}</button>
                  {hospital && hasStudents && (
                    <button
                      disabled={running !== null}
                      title={t('Trade places between students to share each type of shift more evenly, changing as little as possible')}
                      onClick={async () => {
                        setRunning('repair')
                        try {
                          setRepair({ ...(await repairInBackground(config, responses, rosterOf(schedule), changeableFrom(keepTomorrow))), kind: 'fix' })
                          setTimeout(() => document.getElementById('plan')?.scrollIntoView({ behavior: 'smooth' }), 50)
                        } finally {
                          setRunning(null)
                        }
                      }}
                    >
                      {running === 'repair' ? `⏳ ${t('Looking for the fewest changes…')}` : `🔧 ${t('Fix with fewest changes')}`}
                    </button>
                  )}
                  {hospital && hasStudents && config.presentations.length > 0 && (
                    <button
                      title={t('Each presenter from the shift their presentation draws from, and each weekly presentation within one of everyone else’s. Shifts stay as they are.')}
                      onClick={() => {
                        const after = polishPresenters(config, [...schedule.assignments, ...schedule.students], schedule.presenters, changeableFrom(keepTomorrow), schedule.pinned)
                        setRepair({ students: schedule.students, presenters: after, swaps: [], presenterDays: [], kind: 'even' })
                        setTimeout(() => document.getElementById('plan')?.scrollIntoView({ behavior: 'smooth' }), 50)
                      }}
                    >
                      🎤 {t('Even out presenters')}
                    </button>
                  )}
                  {hospital && hasStudents && (
                    <button type="button" aria-pressed={lockMode} className={lockMode ? 'on' : ''} onClick={() => setLockMode(!lockMode)}>
                      📌 {lockMode ? t('Done locking') : t('Lock slots')} {(schedule.pinned?.length ?? 0) > 0 && <span className="badge">{schedule.pinned!.length}</span>}
                    </button>
                  )}
                  {hospital && hasStudents && (
                    <label className="check small">
                      <input type="checkbox" checked={keepTomorrow} onChange={(e) => setKeepTomorrow(e.target.checked)} />
                      {t('Keep tomorrow’s shifts and presenters as they are')}
                    </label>
                  )}
                </>
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
      {me.isHost && shown && hasStudents && <RosterAlerts config={config} responses={responses} roster={shown} label={preview || edit ? t('the roster on screen') : t('the published roster')} />}
      {repair && schedule && !preview && (
        <RepairPlan
          config={config}
          responses={responses}
          before={rosterOf(schedule)}
          plan={repair}
          apply={() => {
            setEdit({ assignments: schedule.assignments, students: repair.students, presenters: repair.presenters, ...(schedule.pinned ? { pinned: schedule.pinned } : {}) })
            setRepair(null)
            setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
          }}
          dismiss={() => setRepair(null)}
        />
      )}
      {schedule && !preview && <Swaps {...{ code, session, me, mutate }} draft={swapDraft} clearDraft={() => setSwapDraft(null)} />}
      {schedule && <Concerns {...{ code, session, me, mutate }} open={inReview} date={concernDate} setDate={setConcernDate} />}
      {schedule && !preview && <FeedbackCard {...{ code, session, me, mutate }} />}
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
          <ShowingLine preview={preview} edit={edit} schedule={schedule} options={options?.length ?? 0} />
          {me.isHost && lockMode && schedule && !preview && !edit && (
            <p className="small lock-bar" role="status">
              📌 {t('Tap a student or presenter to lock them in place; tap again to unlock. 🔧 Fix and 🎤 Even out leave locked ones as they are.')}{' '}
              <button type="button" className="link" onClick={() => setLockMode(false)}>
                {t('Done locking')}
              </button>
            </p>
          )}
          <section className="card flush">
            <RosterTable
              arrange={arrange}
              config={config}
              roster={shown}
              avoidOf={(id, date) => avoidLevel(responseFor(responses, id), date)}
              myId={me.memberId}
              concerns={session.concerns}
              locks={{
                keys: new Set(shown.pinned ?? []),
                toggle: me.isHost && lockMode && schedule && !preview && !edit ? toggleLock : undefined,
              }}
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
              onEditPresenter={
                edit && config.presentations.length
                  ? (date, ruleId, slot, memberId) =>
                      setEdit((cur) => {
                        const list = cur?.presenters ?? []
                        const target = list.filter((p) => p.date === date && p.ruleId === ruleId)[slot]
                        const rest = list.filter((p) => p !== target)
                        // ● when they were on the shift it draws from last night.
                        const rule = config.presentations.find((r) => r.id === ruleId)!
                        const yesterday = (cur?.students ?? []).filter((x) => x.date === addDays(date, -1) && x.memberId === memberId)
                        const postCall = yesterday.some((x) => ruleSources(rule).some((src) => src.when !== 'same' && sourceMatches(config, src, x.shiftId, x.requirementId)))
                        return { ...cur!, presenters: memberId ? [...rest, { date, ruleId, memberId, postCall }] : rest }
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
          {hasStudents && <FairnessTable config={config} responses={responses} roster={shown} />}
          {hasStudents && me.isHost && (
            <Compare
              config={config}
              responses={responses}
              sources={[
                { id: 'shown', label: t('On screen'), roster: shown },
                ...(schedule && (preview || edit) ? [{ id: 'published', label: t('Published roster'), roster: rosterOf(schedule) }] : []),
                ...(session.saved ?? []).map((x) => ({ id: `saved-${x.id}`, label: `📁 ${x.name}`, roster: x.roster })),
                ...(options ?? []).map((o, i) => ({ id: o.id, label: t('Option {n}', { n: i + 1 }), roster: o.roster })),
              ]}
            />
          )}
          {hasStudents && <StudentSummary config={config} roster={shown} myId={me.memberId} />}
          {!hospital && <Stats {...{ code, session, me, mutate }} roster={shown} />}
          <Exports {...{ code, session, me, mutate }} roster={shown} tableRef={tableRef} />
        </>
      )}
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
  const [only, setOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canPost = Boolean(me.isHost || (open && me.memberId))
  const run = (fn: () => Promise<SessionView>) => void mutate(fn).catch((e) => setError((e as Error).message))
  // Open ones first, the most agreed-with at the top, then the newest.
  const score = (c: Concern) => (c.up ?? 0) - (c.down ?? 0)
  const list = [...session.concerns].sort((a, b) => Number(a.resolved) - Number(b.resolved) || score(b) - score(a) || b.createdAt - a.createdAt)
  const openCount = session.concerns.filter((c) => !c.resolved).length

  return (
    <section className="card" id="concerns">
      <h2>
        💬 {t('Concerns')} {openCount > 0 && <span className="badge warn">{t('{n} open', { n: openCount })}</span>}
      </h2>
      {canPost && me.memberId && <p className="muted small">{t("Tip: tap a cell in the roster to raise a concern about that date.")}</p>}
      {canPost ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault()
            setError(null)
            try {
              await mutate(() => api.addConcern(code, { text, date: date || undefined, private: only || undefined }))
              setText('')
              setDate('')
              setOnly(false)
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
            <button className="primary">{only ? `🔒 ${t('Send privately')}` : t("💬 Post")}</button>
          </div>
          {me.memberId && (
            <label className="check small">
              <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} />
              🔒 {t('Only to the host and co-hosts (others won’t see it)')}
            </label>
          )}
        </form>
      ) : (
        <p className="muted small">{me.memberId ? t("The concern period is closed.") : t("Log in to raise a concern.")}</p>
      )}
      {error && <p className="error small">{error}</p>}
      {list.length === 0 ? (
        <p className="muted small">{t("No concerns raised.")}</p>
      ) : (
        <ul className="concerns">
          {list.map((c) => (
            <ConcernItem key={c.id} c={c} {...{ code, session, me }} canPost={canPost} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConcernItem({
  c,
  code,
  session,
  me,
  canPost,
  run,
}: Pick<SessionProps, 'code' | 'session' | 'me'> & { c: Concern; canPost: boolean; run: (fn: () => Promise<SessionView>) => void }) {
  const [reply, setReply] = useState('')
  const name = (id: string) => (id === 'host' ? t('Host') : (session.config.members.find((m) => m.id === id)?.name ?? '?'))
  const mine = me.memberId !== null && c.memberId === me.memberId
  const myVote = me.memberId ? c.votes?.[me.memberId] : undefined
  const vote = (v: 1 | -1) => run(() => api.voteConcern(code, c.id, myVote === v ? 0 : v))
  return (
    <li className={`${c.resolved ? 'resolved' : ''} ${c.private ? 'private' : ''}`}>
      <div>
        <strong>{name(c.memberId)}</strong>
        {c.private && <span className="badge">🔒 {mine ? t('Only you and the hosts') : t('Private')}</span>}
        {c.date && <span className="badge">{shortDate(c.date)}</span>}
        <span className="muted tiny"> {new Date(c.createdAt).toLocaleString()}</span>
      </div>
      <p>{c.text}</p>
      <div className="row wrap concern-actions">
        {!c.private && (
          <>
            <button
              type="button"
              className={`chip vote ${myVote === 1 ? 'on' : ''}`}
              aria-pressed={myVote === 1}
              disabled={!me.memberId || !canPost}
              title={t('Agree')}
              onClick={() => vote(1)}
            >
              👍 {c.up ?? 0}
            </button>
            <button
              type="button"
              className={`chip vote ${myVote === -1 ? 'on' : ''}`}
              aria-pressed={myVote === -1}
              disabled={!me.memberId || !canPost}
              title={t('Disagree')}
              onClick={() => vote(-1)}
            >
              👎 {c.down ?? 0}
            </button>
          </>
        )}
        {me.isHost && (
          <button type="button" className="link" onClick={() => run(() => api.resolveConcern(code, c.id, !c.resolved))}>
            {c.resolved ? t("Reopen") : t("Mark resolved")}
          </button>
        )}
        {(mine || me.isHost) && (
          <ConfirmButton className="link danger" confirmText={t('Tap again to delete')} onConfirm={() => run(() => api.removeConcern(code, c.id))}>
            {t('Delete')}
          </ConfirmButton>
        )}
      </div>
      {(c.replies?.length ?? 0) > 0 && (
        <ul className="replies">
          {c.replies!.map((r) => (
            <li key={r.id}>
              <span className="small">
                <strong>{r.memberId === 'host' ? (r.by ? `${r.by} (${t(r.role === 'cohost' ? 'Co-host' : 'Host')})` : t(r.role === 'cohost' ? 'Co-host' : 'Host')) : name(r.memberId)}</strong>{' '}
                <span className="muted tiny">{new Date(r.at).toLocaleString()}</span>
              </span>
              <p>{r.text}</p>
              {(me.isHost || (me.memberId !== null && r.memberId === me.memberId)) && (
                <button type="button" className="link small" onClick={() => run(() => api.removeReply(code, c.id, r.id))}>
                  {t('Delete')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canPost && (
        <form
          className="row reply-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!reply.trim()) return
            run(() =>
              api.replyConcern(code, c.id, reply).then((v) => {
                setReply('')
                return v
              }),
            )
          }}
        >
          <input className="grow" value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('Reply…')} aria-label={t('Reply to {name}', { name: name(c.memberId) })} />
          <button type="submit" disabled={!reply.trim()}>{t('Reply')}</button>
        </form>
      )}
    </li>
  )
}

/** The fewest-changes fix: what it would change and what it gets you, before applying it as edits. */
function RepairPlan({
  config,
  responses,
  before,
  plan,
  apply,
  dismiss,
}: {
  config: SessionConfig
  responses: Record<string, MemberResponse>
  before: Roster
  plan: RepairResult & { kind: 'fix' | 'even' }
  apply: () => void
  dismiss: () => void
}) {
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  const shift = (id: string) => config.shifts.find((s) => s.id === id)?.name ?? ''
  const rule = (id: string) => config.presentations.find((r) => r.id === id)?.name ?? ''
  const after = { assignments: before.assignments, students: plan.students, presenters: plan.presenters }
  const [b, a] = [studentRuleReport(config, responses, before), studentRuleReport(config, responses, after)]
  const [ub, ua] = [typeSpread(config, before.students, before.presenters), typeSpread(config, plan.students, plan.presenters)]
  // Presenter changes, per day and presentation: who stops and who starts.
  const keys = [...new Set([...before.presenters, ...plan.presenters].map((p) => `${p.date}|${p.ruleId}`))].sort()
  const presenterChanges = keys.flatMap((k) => {
    const [date, ruleId] = k.split('|')
    const was = before.presenters.filter((p) => p.date === date && p.ruleId === ruleId).map((p) => p.memberId)
    const now = plan.presenters.filter((p) => p.date === date && p.ruleId === ruleId).map((p) => p.memberId)
    const out = was.filter((id) => !now.includes(id))
    const into = now.filter((id) => !was.includes(id))
    return out.length || into.length ? [{ date, ruleId, out, into }] : []
  })
  // What it clears and what it brings, from the hosts' alert list.
  const [alertsBefore, alertsAfter] = [rosterAlerts(config, responses, before), rosterAlerts(config, responses, after)]
  const fixed = alertsBefore.filter((x) => !alertsAfter.some((y) => y.text === x.text))
  const added = alertsAfter.filter((x) => !alertsBefore.some((y) => y.text === x.text))
  const nothing = plan.swaps.length === 0 && presenterChanges.length === 0
  const mark = (level: 'rule' | 'wish') => (level === 'rule' ? '🚨' : '⚠️')
  return (
    <section className="card repair" id="plan">
      <h2>{plan.kind === 'even' ? `🎤 ${t('Even out presenters')}` : `🔧 ${t('Fix with fewest changes')}`}</h2>
      {nothing ? (
        <p>{plan.kind === 'even' ? t('Presenters already fit — nothing to change.') : t('Nothing to fix — no trade between students would make it fairer.')}</p>
      ) : (
        <>
          <p className="small">
            {plan.swaps.length > 0 && t('{n} trade(s) between students ({same} on the same day, so nobody’s dates change).', { n: plan.swaps.length, same: plan.swaps.filter((x) => x.a.date === x.b.date).length })}{' '}
            {presenterChanges.length > 0 && t('{n} presenter change(s).', { n: presenterChanges.reduce((n, x) => n + Math.max(x.out.length, x.into.length), 0) })}
          </p>
          {(fixed.length > 0 || added.length > 0) && (
            <div className="plan-effects">
              {fixed.length > 0 && (
                <>
                  <h3>✅ {t('Fixes ({n})', { n: fixed.length })}</h3>
                  <ul className="small alert-list">
                    {fixed.map((x, i) => (
                      <li key={i}>
                        <s>
                          {mark(x.level)} {x.text}
                        </s>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {added.length > 0 && (
                <>
                  <h3>➕ {t('Brings in ({n})', { n: added.length })}</h3>
                  <ul className="small alert-list">
                    {added.map((x, i) => (
                      <li key={i}>
                        {mark(x.level)} {x.text}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {plan.swaps.length > 0 && (
            <>
              <h3>🔁 {t('Shift trades')}</h3>
              <ol className="small repair-list">
                {plan.swaps.map((x, i) => (
                  <li key={i}>
                    {x.a.date === x.b.date
                      ? t('{date}: {a} takes {b}’s {sb} and {b} takes {a}’s {sa}', {
                          date: shortDate(x.a.date),
                          a: name(x.a.memberId),
                          b: name(x.b.memberId),
                          sa: shift(x.a.shiftId),
                          sb: shift(x.b.shiftId),
                        })
                      : t('{a} moves from {da} {sa} to {db} {sb}; {b} the other way', {
                          a: name(x.a.memberId),
                          b: name(x.b.memberId),
                          da: shortDate(x.a.date),
                          db: shortDate(x.b.date),
                          sa: shift(x.a.shiftId),
                          sb: shift(x.b.shiftId),
                        })}
                  </li>
                ))}
              </ol>
            </>
          )}
          {presenterChanges.length > 0 && (
            <>
              <h3>🎤 {t('Presenter changes')}</h3>
              <ul className="small repair-list">
                {presenterChanges.map((x) => (
                  <li key={`${x.date}|${x.ruleId}`}>
                    <b>
                      {shortDate(x.date)} {rule(x.ruleId)}
                    </b>
                    : {x.out.map(name).join(', ') || '—'} → {x.into.map(name).join(', ') || '—'}
                  </li>
                ))}
              </ul>
            </>
          )}
          <table className="mini">
            <thead>
              <tr>
                <th />
                <th>{t('Now')}</th>
                <th>{t('After')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('Uneven shift types')}</td>
                <td>{ub}</td>
                <td>
                  <b>{ua}</b>
                </td>
              </tr>
              <tr>
                <td>{t('Avoid requests not met')}</td>
                <td>{b.avoidHits[1] + b.avoidHits[2] + b.avoidHits[3]}</td>
                <td>
                  <b>{a.avoidHits[1] + a.avoidHits[2] + a.avoidHits[3]}</b>
                </td>
              </tr>
              <tr>
                <td>{t('Points apart')}</td>
                <td>{fmtPoints(b.pointsSpread)}</td>
                <td>
                  <b>{fmtPoints(a.pointsSpread)}</b>
                </td>
              </tr>
              <tr>
                <td>{t('Rules broken')}</td>
                <td>{alertsBefore.filter((x) => x.level === 'rule').length}</td>
                <td>
                  <b>{alertsAfter.filter((x) => x.level === 'rule').length}</b>
                </td>
              </tr>
              <tr>
                <td>{t('Preferences not met')}</td>
                <td>{alertsBefore.filter((x) => x.level === 'wish').length}</td>
                <td>
                  <b>{alertsAfter.filter((x) => x.level === 'wish').length}</b>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">{t('Applying opens them as edits, so you can check the table and change anything before saving.')}</p>
        </>
      )}
      <div className="row wrap">
        {!nothing && (
          <button type="button" className="primary" onClick={apply}>
            {t('Apply as edits')}
          </button>
        )}
        <button type="button" onClick={dismiss}>
          {t('Close')}
        </button>
      </div>
    </section>
  )
}


/** Which arrangement the table below is showing. */
function ShowingLine({ preview, edit, schedule, options }: { preview: Preview | null; edit: Roster | null; schedule: Schedule | null; options: number }) {
  let what: string
  if (preview) {
    const n = preview.name?.match(/^(?:Option|แบบที่) (\d+)$/)?.[1]
    what = preview.savedId
      ? t('saved arrangement “{name}”', { name: preview.name ?? '' })
      : n && options
        ? t('{name} of {n}', { name: preview.name!, n: options })
        : (preview.name ?? t('the arrangement being tried out'))
  } else if (schedule) {
    what = schedule.status === 'final' ? t('the published roster (final)') : t('the published roster (in review)')
  } else return null
  const changed = Boolean(preview?.base) || Boolean(edit)
  return (
    <p className="showing small">
      👁️ {t('Showing:')} <b>{what}</b>
      {changed && <span className="muted"> · {t('changed by hand')}</span>}
      {preview && <span className="muted"> · {t('not published')}</span>}
    </p>
  )
}

const mark = (ok: boolean | null) => (ok === true ? '✅' : ok === false ? '⚠️' : '')

/** Every fairness rule, its setting and this roster's result. */
function FairnessTable({ config, responses, roster }: { config: SessionConfig; responses: Record<string, MemberResponse>; roster: Roster }) {
  const rows = fairnessReport(config, responses, roster)
  return (
    <section className="card">
      <h2>⚖️ {t('Fairness')}</h2>
      <div className="scroll-x">
        <table className="mini fairness">
          <thead>
            <tr>
              <th>{t('What')}</th>
              <th>{t('Rule')}</th>
              <th>{t('Result')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.ok === false ? 'bad' : ''}>
                <td>{r.what}</td>
                <td className="muted">{r.setting}</td>
                <td>{r.result}</td>
                <td>{mark(r.ok)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shareGroups(config).length > 1 && <p className="muted small">{t('“a–b / c–d”: one range per group of students who take the same places (e.g. each rotation).')}</p>}
    </section>
  )
}

/** Two arrangements side by side: every fairness rule for each, and how many shifts differ. */
function Compare({
  config,
  responses,
  sources,
}: {
  config: SessionConfig
  responses: Record<string, MemberResponse>
  sources: { id: string; label: string; roster: Roster }[]
}) {
  const [aId, setA] = useState<string>(sources[0]?.id ?? '')
  const [bId, setB] = useState<string>(sources[1]?.id ?? '')
  if (sources.length < 2) return null
  const a = sources.find((x) => x.id === aId) ?? sources[0]
  const b = sources.find((x) => x.id === bId) ?? sources.find((x) => x.id !== a.id)!
  const [ra, rb] = [fairnessReport(config, responses, a.roster), fairnessReport(config, responses, b.roster)]
  const pick = (value: string, set: (v: string) => void, label: string) => (
    <select value={value} onChange={(e) => set(e.target.value)} aria-label={label}>
      {sources.map((x) => (
        <option key={x.id} value={x.id}>
          {x.label}
        </option>
      ))}
    </select>
  )
  return (
    <section className="card">
      <h2>🔀 {t('Compare two arrangements')}</h2>
      <div className="row wrap">
        {pick(a.id, setA, 'A')} <span className="muted">{t('with')}</span> {pick(b.id, setB, 'B')}
      </div>
      <p className="small">{t('{n} shift(s) differ.', { n: differs(a.roster, b.roster) })}</p>
      <div className="scroll-x">
        <table className="mini fairness">
          <thead>
            <tr>
              <th>{t('What')}</th>
              <th>{a.label}</th>
              <th>{b.label}</th>
            </tr>
          </thead>
          <tbody>
            {ra.map((r) => {
              const o = rb.find((x) => x.key === r.key)
              return (
                <tr key={r.key} className={o && o.result !== r.result ? 'differs' : ''}>
                  <td>{r.what}</td>
                  <td>
                    {r.result} {mark(r.ok)}
                  </td>
                  <td>
                    {o?.result ?? '—'} {o && mark(o.ok)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** "Save for later": keep the arrangement on screen under a name, to open again from Saved arrangements. */
function SaveForLater({ count, save }: { count: number; save: (name: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  if (count >= MOST_SAVED && !open) return <span className="muted small">{t('{n} saved — delete one to save another.', { n: count })}</span>
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        💾 {state === 'saved' ? t('Saved ✓ — save another') : t('Save for later')}
      </button>
    )
  }
  return (
    <span className="row wrap save-later">
      <input autoFocus maxLength={80} value={name} placeholder={t('Name, e.g. Fewer weekends for group B')} onChange={(e) => setName(e.target.value)} aria-label={t('Name')} />
      <button
        type="button"
        className="primary"
        disabled={state === 'saving'}
        onClick={async () => {
          setState('saving')
          try {
            await save(name || t('Arrangement {n}', { n: count + 1 }))
            setState('saved')
            setOpen(false)
            setName('')
          } catch {
            setState('error')
          }
        }}
      >
        {t('Save')}
      </button>
      <button type="button" className="link" onClick={() => setOpen(false)}>{t('Cancel')}</button>
      {state === 'error' && <span className="error small">{t('Couldn’t save — try again.')}</span>}
    </span>
  )
}

/** Arrangements kept for later: what each looks like, and one tap to open it again (or delete it). */
function SavedArrangements({
  config,
  responses,
  saved,
  open,
  remove,
  openId,
}: {
  config: SessionConfig
  responses: Record<string, MemberResponse>
  saved: SavedArrangement[]
  open: (x: SavedArrangement) => void
  remove: (id: string) => void
  openId?: string
}) {
  return (
    <section className="card saved">
      <h2>📁 {t('Saved arrangements ({n})', { n: saved.length })}</h2>
      <p className="muted small">{t('Only you and your co-hosts see these. Open one to look at it again, change it or publish it.')}</p>
      <ul>
        {[...saved].reverse().map((x) => (
          <li key={x.id} className={x.id === openId ? 'open' : ''}>
            <div className="row wrap between">
              <strong>
                {x.name}
                {x.id === openId && <span className="badge"> {t('showing')}</span>}
              </strong>
              <span className="row">
                <button type="button" className="primary" onClick={() => open(x)}>{t('Open')}</button>
                <ConfirmButton className="link danger" confirmText={t('tap to delete')} onConfirm={() => remove(x.id)}>
                  {t('Delete')}
                </ConfirmButton>
              </span>
            </div>
            <span className="muted small">{t('Saved {time}', { time: new Date(x.savedAt).toLocaleString() })}</span>
            <p className="small">{studentRuleReport(config, responses, x.roster).summary.join(' · ')}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Hosts only: every rule and preference the roster breaks, by person and day, so nothing slips through. */
function RosterAlerts({ config, responses, roster, label }: { config: SessionConfig; responses: Record<string, MemberResponse>; roster: Roster; label: string }) {
  const all = useMemo(() => rosterAlerts(config, responses, roster), [config, responses, roster])
  const rules = all.filter((a) => a.level === 'rule')
  const wishes = all.filter((a) => a.level === 'wish')
  return (
    <section className={`card roster-alerts ${rules.length ? 'has-rules' : ''}`} aria-live="polite">
      <h2>
        {rules.length ? '🚨' : '✅'} {t('What {which} breaks', { which: label })} <span className="badge host">{t('Hosts only')}</span>
      </h2>
      {all.length === 0 && <p className="small">{t('Nothing — every rule and preference is kept.')}</p>}
      {rules.length > 0 && (
        <>
          <h3>{t('Rules you set ({n})', { n: rules.length })}</h3>
          <ul className="small alert-list">
            {rules.map((a, i) => (
              <li key={i}>🚨 {a.text}</li>
            ))}
          </ul>
        </>
      )}
      {wishes.length > 0 && (
        <details open={rules.length === 0 && wishes.length <= 5}>
          <summary className="small">⚠️ {t('Preferences not met ({n})', { n: wishes.length })}</summary>
          <ul className="small alert-list">
            {wishes.map((a, i) => (
              <li key={i}>{a.text}</li>
            ))}
          </ul>
        </details>
      )}
      {all.length > 0 && <p className="muted small">{t('Try 🎤 Even out presenters or 🔧 Fix with fewest changes, or edit by hand — this list updates as you go.')}</p>}
    </section>
  )
}

function RulesCheck({ config, responses, roster }: { config: SessionConfig; responses: Record<string, MemberResponse>; roster: Roster }) {
  const r = studentRuleReport(config, responses, roster)
  if (!r.summary.length) return null
  const ok = r.details.length === 0
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  const level = (n: number) => '!'.repeat(n)
  return (
    <section className={`card rules-check ${ok ? 'ok' : ''}`}>
      <h2>{ok ? '✅' : '⚠️'} {t('Rules check')}</h2>
      <p className="small">{r.summary.join(' · ')}</p>
      {r.unmet.length > 0 && (
        <div className="stack-tight">
          <h3>🙅 {t('Days people asked to avoid but got ({n} people)', { n: r.unmet.length })}</h3>
          <p className="muted small">{t('Marked in the roster below. Wayneday gives !!! days off first, then !!, then !.')}</p>
          <ul className="small unmet-list">
            {[...r.unmet]
              .sort((a, b) => Math.max(...b.days.map((d) => d.level)) - Math.max(...a.days.map((d) => d.level)))
              .map((u) => (
                <li key={u.memberId}>
                  <b>{name(u.memberId)}</b>:{' '}
                  {u.days.map((d, i) => (
                    <span key={d.date} className={`unmet unmet-${d.level}`}>
                      {i > 0 && ', '}
                      {shortDate(d.date)} {level(d.level)}
                    </span>
                  ))}
                </li>
              ))}
          </ul>
        </div>
      )}
      {r.pairRepeats.length > 0 && (
        <details>
          <summary className="small">
            👥 {t('{n} pair(s) of students together more than once', { n: r.pairRepeats.length })}
          </summary>
          <p className="muted small">
            {t('You asked never to put the same two students on a shift together twice. With this many students per shift some pairs meet again; Wayneday keeps it as low as it can. These pairs share a shift more than once:')}
          </p>
          <ul className="small">
            {r.pairRepeats.map((p) => (
              <li key={`${p.a}|${p.b}`}>{t('{a} & {b} — {n} shifts together', { a: name(p.a), b: name(p.b), n: p.n })}</li>
            ))}
          </ul>
        </details>
      )}
      {r.meets.length > 0 && (
        <details>
          <summary className="small">🔁 {t('{n} time(s) a student meets the same resident or staff again', { n: r.meets.length })}</summary>
          <ul className="small">
            {r.meets.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function StudentSummary({ config, roster, myId }: { config: SessionConfig; roster: Roster; myId: string | null }) {
  const details = studentDetails(config, roster)
  const [open, setOpen] = useState<string | null>(null)
  const pointsOn = Boolean(config.students.points?.on)
  const weekly = config.presentations.filter((r) => !isOneDay(r))
  const anyOneDay = config.presentations.some(isOneDay)
  const label = (s: (typeof details)[number]['shifts'][number]) => `${s.shift}${s.ward ? ` · ${s.ward}` : ''}`
  const days = (n: number | null) => (n == null ? '-' : fmtPoints(Math.round(n * 10) / 10))
  // One compact block per student (a table gets too wide on a phone); tap to see every shift and who's there.
  return (
    <section className="card">
      <h2>🎓 {t('Per student')}</h2>
      <Expandable title={t('Per student')}>
        <p className="muted small">{t('Tap a student to see each shift and who they’re with.')}</p>
        <ul className="per-student">
          {details.map((d) => {
            const isOpen = open === d.member.id
            const talks = [
              ...(weekly.length > 1 || anyOneDay ? weekly.map((r) => `${r.name} ${d.byRule(r.id)}`) : []),
              ...(anyOneDay ? [`${t('one-day')} ${d.oneDay}`] : []),
            ]
            return (
              <li key={d.member.id} className={`${isOpen ? 'open' : ''} ${d.member.id === myId ? 'me' : ''}`}>
                <button type="button" className="ps-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : d.member.id)}>
                  <span className="ps-name">
                    <span aria-hidden>{isOpen ? '▾' : '▸'}</span>{' '}
                    <span className="who-chip" style={{ '--h': personHue(config, d.member.id) ?? 0 } as CSSProperties}>
                      {d.member.name}
                    </span>
                  </span>
                  <span className="ps-stats small">
                    {t('{n} shifts', { n: d.shifts.length })}
                    {d.gap.avg != null && ` · ${t('every {n} days', { n: days(d.gap.avg) })}`}
                    {pointsOn && ` · ${t('{p} pts', { p: fmtPoints(d.points) })}`}
                    {config.presentations.length > 0 && ` · 🎤 ${d.presents.length}${talks.length ? ` (${talks.join(', ')})` : ''}`}
                  </span>
                </button>
                <div className="ps-types small">
                  {d.gap.bySlot.map((x) => (
                    <span key={x.shift} className="type-count">
                      {x.shift} <b>{x.count}</b>
                    </span>
                  ))}
                </div>
                {!isOpen && (
                  <div className="ps-dates">
                    {d.shifts.map((s) => (
                      <span key={s.date + s.shift} className="date-chip" title={`${label(s)}${s.with.length ? ` — ${t('with')} ${s.with.join(', ')}` : ''}`}>
                        {shortDate(s.date)}
                        {s.ward && <span className="muted"> {s.ward}</span>}
                      </span>
                    ))}
                  </div>
                )}
                {isOpen && d.gap.avg != null && (
                  <p className="small gaps">
                    ⏱️ {t('Days between shifts: {avg} on average, {short} at the shortest.', { avg: days(d.gap.avg), short: d.gap.shortest ?? '-' })}{' '}
                    {d.gap.bySlot
                      .filter((x) => x.avg != null)
                      .map((x) => t('{shift}: every {n} days', { shift: x.shift, n: days(x.avg) }))
                      .join(' · ')}
                  </p>
                )}
                {isOpen && (
                  <ul className="shift-list small">
                    {d.shifts.map((s) => (
                      <li key={s.date + s.shift}>
                        <b>{shortDate(s.date)}</b> · {label(s)} <span className="muted">({s.times})</span>
                        <div className="muted">
                          {t('with')} {s.with.join(', ') || '—'}
                          {(s.residents.length > 0 || s.staff.length > 0) && ` · ${[...s.residents, ...s.staff].join(', ')}`}
                        </div>
                      </li>
                    ))}
                    {d.presents.map((p) => (
                      <li key={p.date + p.ruleId}>
                        🎤 <b>{shortDate(p.date)}</b> · {p.name}
                        {p.postCall && <span title={t("Was on last night’s shift")}> ●</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      </Expandable>
    </section>
  )
}
