import { Fragment, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../api.ts'
import { shiftRuns, shiftsForType, shiftsOn } from '../shared/calendar.ts'
import { t, typeName } from '../shared/i18n.ts'
import { dateRange, shortDate, weekday } from '../shared/dates.ts'
import { responseFor } from '../shared/solver.ts'
import { DEFAULT_RESPONSE, type AnswerChange, type AvoidLevel, type HostNote, type MemberResponse } from '../shared/types.ts'
import type { SessionProps } from './props.ts'
import Expandable from './Expandable.tsx'

// 'mark' = can't work / would rather not, at the chosen level (0 = can't at all).
type Tool = 'mark' | 'lock' | 'clear'
type MarkLevel = 0 | AvoidLevel

const AVOID_LABEL = ['', 'Rather not', 'Important', 'Really need it off']
const MARK_LABEL = ['Can’t', ...AVOID_LABEL.slice(1)]

const STATUS = {
  ready: { icon: '✅', label: '{n} ready' },
  filling: { icon: '⏳', label: '{n} filling in' },
  away: { icon: '💤', label: '{n} not logged in yet' },
} as const

export default function AvailabilityTab({ code, session, me, mutate }: SessionProps) {
  const { config } = session
  const [pending, setPending] = useState<Record<string, MemberResponse>>({})
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [tool, setTool] = useState<Tool>('mark')
  const [editOthers, setEditOthers] = useState(false)
  // Host editing someone else's answers says why; they're sent it as a note.
  const [reason, setReason] = useState('')
  const reasonRef = useRef('')
  useEffect(() => {
    reasonRef.current = editOthers ? reason.trim() : ''
  })
  // Host: whose notes are open in Everyone's answers.
  const [notesFor, setNotesFor] = useState<string | null>(null)
  const [markLvl, setMarkLvl] = useState<MarkLevel>(0)
  const [notice, setNotice] = useState<string | null>(null)
  const myType = config.members.find((m) => m.id === me.memberId)?.type
  // A member only sees shift slots they can actually work; the host sees all.
  const lockChoices = me.isHost || !myType ? config.shifts : shiftsForType(config, myType)
  const [chosenLockShift, setLockShift] = useState('')
  const lockShift = lockChoices.some((s) => s.id === chosenLockShift) ? chosenLockShift : (lockChoices[0]?.id ?? '')
  // Undo: each tap/drag or preference change is one step; a step remembers everyone it touched.
  const undoStack = useRef<Map<string, MemberResponse>[]>([])
  const stroke = useRef<Map<string, MemberResponse> | null>(null)
  const [undoCount, setUndoCount] = useState(0)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const latest = useRef(pending)
  useEffect(() => {
    latest.current = pending
  })

  const respOf = useCallback(
    (memberId: string) => pending[memberId] ?? responseFor(session.responses, memberId),
    [pending, session.responses],
  )
  const canEdit = (memberId: string) =>
    (me.memberId === memberId || (me.isHost && editOthers)) && (me.isHost || session.schedule?.status !== 'final')

  function remember(memberId: string) {
    const target = stroke.current ?? new Map<string, MemberResponse>()
    if (!target.has(memberId)) target.set(memberId, respOf(memberId))
    if (!stroke.current) {
      undoStack.current.push(target)
      setUndoCount(undoStack.current.length)
    }
  }

  const update = useCallback(
    (memberId: string, fn: (r: MemberResponse) => MemberResponse) => {
      setPending((p) => ({ ...p, [memberId]: fn(p[memberId] ?? responseFor(session.responses, memberId)) }))
      clearTimeout(timers.current[memberId])
      timers.current[memberId] = setTimeout(async () => {
        const r = latest.current[memberId]
        if (!r) return
        setSaveState('saving')
        try {
          const why = me.isHost && memberId !== me.memberId ? reasonRef.current : ''
          await mutate(() => api.saveResponse(code, memberId, r, why || undefined))
          setPending((p) => {
            if (p[memberId] !== r) return p // edited again meanwhile
            const { [memberId]: _done, ...rest } = p
            return rest
          })
          setSaveState('idle')
        } catch {
          setSaveState('error')
        }
      }, 700)
    },
    [code, mutate, session.responses, me.isHost, me.memberId],
  )

  // ---- painting ----
  const paint = useRef<{ mode: Tool } | null>(null)

  function cellState(r: MemberResponse, date: string) {
    if (r.unavailable.includes(date)) return { kind: 'unavailable' as const }
    const lock = r.locks.find((l) => l.date === date)
    if (lock) return { kind: 'lock' as const, shiftId: lock.shiftId }
    const avoid = r.avoid?.find((a) => a.date === date)
    return avoid ? { kind: 'avoid' as const, level: avoid.level } : { kind: 'free' as const }
  }

  /** A host changing someone else's answers must give a reason first. */
  const needsReason = (memberId: string) => me.isHost && memberId !== me.memberId && !reason.trim()
  const reasonFirst = () => setNotice(t('Write why you’re changing their answers first — they’ll see it.'))

  function apply(memberId: string, date: string, mode: Tool) {
    if (!canEdit(memberId)) return
    if (needsReason(memberId)) return reasonFirst()
    const shift = config.shifts.find((s) => s.id === lockShift)
    if (mode === 'lock') {
      const member = config.members.find((m) => m.id === memberId)!
      if (!shift || !shiftRuns(config, shift, date)) return setNotice(t('{shift} doesn’t run on {date}.', { shift: shift?.name ?? t('That shift'), date: shortDate(date) }))
      if (!shiftsForType(config, member.type).some((s) => s.id === shift.id)) {
        return setNotice(t('{name} can’t be locked into {shift} — it has no places for them.', { name: member.name, shift: shift.name }))
      }
    }
    setNotice(null)
    remember(memberId)
    update(memberId, (r) => {
      const unavailable = r.unavailable.filter((d) => d !== date)
      const locks = r.locks.filter((l) => l.date !== date)
      const avoid = (r.avoid ?? []).filter((a) => a.date !== date)
      if (mode === 'mark' && markLvl > 0) avoid.push({ date, level: markLvl as AvoidLevel })
      if (mode === 'mark' && markLvl === 0) unavailable.push(date)
      if (mode === 'lock') locks.push({ date, shiftId: lockShift })
      return { ...r, unavailable, locks, avoid }
    })
  }

  function cellAt(x: number, y: number) {
    const td = document.elementFromPoint(x, y)?.closest<HTMLElement>('td[data-date]')
    return td ? { date: td.dataset.date!, memberId: td.dataset.member! } : null
  }

  function onDown(e: ReactPointerEvent) {
    const c = cellAt(e.clientX, e.clientY)
    if (!c || !canEdit(c.memberId)) return
    const st = cellState(respOf(c.memberId), c.date)
    // Pressing on a cell that already has this state erases instead.
    const same =
      (tool === 'mark' && markLvl === 0 && st.kind === 'unavailable') ||
      (tool === 'mark' && markLvl > 0 && st.kind === 'avoid' && st.level === markLvl) ||
      (tool === 'lock' && st.kind === 'lock' && st.shiftId === lockShift)
    const mode: Tool = same ? 'clear' : tool
    paint.current = { mode }
    stroke.current = new Map()
    apply(c.memberId, c.date, mode)
    e.preventDefault()
  }
  function onMove(e: ReactPointerEvent) {
    if (!paint.current || e.pointerType === 'touch') return
    const c = cellAt(e.clientX, e.clientY)
    if (c) {
      const st = cellState(respOf(c.memberId), c.date)
      const want = paint.current.mode
      const already =
        (want === 'clear' && st.kind === 'free') ||
        (want === 'mark' && markLvl === 0 && st.kind === 'unavailable') ||
        (want === 'lock' && st.kind === 'lock' && st.shiftId === lockShift) ||
        (want === 'mark' && markLvl > 0 && st.kind === 'avoid' && st.level === markLvl)
      if (!already) apply(c.memberId, c.date, want)
    }
  }
  useEffect(() => {
    const up = () => {
      paint.current = null
      if (stroke.current?.size) {
        undoStack.current.push(stroke.current)
        setUndoCount(undoStack.current.length)
      }
      stroke.current = null
    }
    addEventListener('pointerup', up)
    return () => removeEventListener('pointerup', up)
  }, [])

  const days = dateRange(config.startDate, config.endDate)
  // In hospital mode residents/staff come from the hospital's roster; only students answer here.
  const hospital = config.rosterMode === 'hospital'
  const answering = config.members.filter((m) => !hospital || m.type === 'student')
  // Ready, logged in and still filling in, or not logged in yet (an answer the host filled in counts as filling in).
  const statusOf = (id: string): keyof typeof STATUS =>
    respOf(id).ready ? 'ready' : session.claimed.includes(id) || session.responses[id] ? 'filling' : 'away'
  const statusIcon = (id: string) => {
    const status = statusOf(id)
    const title =
      status === 'ready'
        ? t('Ready since {time}', { time: new Date(respOf(id).ready!).toLocaleString() })
        : status === 'filling'
          ? t('Logged in, not ready yet')
          : t('Hasn’t logged in yet')
    return <span title={title}>{STATUS[status].icon} </span>
  }
  const members = [...answering].sort((a, b) => Number(b.id === me.memberId) - Number(a.id === me.memberId))
  const iAnswer = Boolean(me.memberId && answering.some((m) => m.id === me.memberId))
  const mine = me.memberId && iAnswer ? respOf(me.memberId) : null
  const holidays = new Set(config.holidays)
  const shiftShort = (id: string) => config.shifts.find((s) => s.id === id)?.name.slice(0, 5) ?? '?'

  function undo() {
    const step = undoStack.current.pop()
    setUndoCount(undoStack.current.length)
    if (!step) return
    for (const [memberId, before] of step) update(memberId, () => before)
  }
  const hostEditing = (memberId: string) => me.isHost && editOthers && memberId !== me.memberId
  /** Host changing someone else's pattern or interval in Everyone's answers. */
  const editAnswer = (memberId: string, fn: (r: MemberResponse) => MemberResponse) => {
    if (needsReason(memberId)) return reasonFirst()
    remember(memberId)
    update(memberId, fn)
  }
  const setPref = (fn: (r: MemberResponse) => MemberResponse) => {
    remember(me.memberId!)
    update(me.memberId!, fn)
  }

  // Latest host change to my answers that I haven't acknowledged.
  const ackKey = `wayneday:ack:${code}:${me.memberId}`
  const [ack, setAck] = useState(() => {
    try {
      return Number(localStorage.getItem(ackKey) ?? 0)
    } catch {
      return 0
    }
  })
  const acknowledge = (at: number) => {
    setAck(at)
    try {
      localStorage.setItem(ackKey, String(at))
    } catch {
      // per-tab only
    }
  }
  const hostChange = me.memberId
    ? [...session.changes].reverse().find((c) => c.memberId === me.memberId && c.at > ack && !me.isHost && !c.reason)
    : undefined
  const nameOf = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'

  if (config.members.length === 0) {
    return <p className="muted">{t("The host hasn't added anyone yet.")}</p>;
  }
  if (members.length === 0) {
    return (
      <p className="muted">{t(
        "No students yet. Residents and staff come from the hospital roster, so only students fill in this page."
      )}</p>
    );
  }

  return (
    <div className="stack">
      {hostChange && (
        <div className="alert warn" role="status">
          <strong>{t("The host changed your answers")}</strong> ({new Date(hostChange.at).toLocaleString()}): {hostChange.summary}.
          <div className="row wrap">
            <button
              onClick={() => {
                update(me.memberId!, () => hostChange.before ?? DEFAULT_RESPONSE)
                acknowledge(hostChange.at)
              }}
            >{t("Restore my previous answers")}</button>
            <button className="link" onClick={() => acknowledge(hostChange.at)}>{t("Keep the change")}</button>
          </div>
        </div>
      )}
      {hospital && me.memberId && !iAnswer && (
        <p className="muted small">{t(
          "Your shifts come from the hospital roster, so there’s nothing for you to fill in here. Students’ answers are below."
        )}</p>
      )}
      {mine && me.memberId && (
        <section className="card">
          <h2>🙋 {t('My preferences')}</h2>
          <div className="row wrap">
            <div className="segmented" role="radiogroup" aria-label={t("Shift pattern")}>
              {(
                [
                  ['distributed', 'Spread out', 'Shifts evenly spaced across the period'],
                  ['dense', 'Grouped', 'Shifts close together, at your minimum interval'],
                ] as const
              ).map(([v, label, hint]) => (
                <button
                  key={v}
                  role="radio"
                  aria-checked={mine.preference === v}
                  className={mine.preference === v ? 'on' : ''}
                  title={t(hint)}
                  disabled={!canEdit(me.memberId!)}
                  onClick={() => setPref((r) => ({ ...r, preference: v }))}
                >
                  {v === 'distributed' ? '🌤️' : '📦'} {t(label)}
                </button>
              ))}
            </div>
            <label className="inline">{t("At least")} <input
                type="number"
                min={1}
                max={60}
                value={mine.minInterval}
                disabled={!canEdit(me.memberId)}
                onChange={(e) => setPref((r) => ({ ...r, minInterval: Math.max(1, Number(e.target.value) || 1) }))}
              /> {t("days between shifts")}</label>
          </div>
          <p className="muted small">
            {mine.minInterval === 1 ? t("Consecutive days are OK.") : `e.g. a shift on the 1st means the next is the ${mine.minInterval + 1}th at the earliest.`}{' '} {t(
              "Spread-out preferences are given priority; grouped shifts are packed as close as your interval allows."
            )}</p>
          <label>{t("Note for the host")} <input
              value={mine.note}
              disabled={!canEdit(me.memberId)}
              placeholder={t("e.g. exam on the 14th")}
              onChange={(e) => update(me.memberId!, (r) => ({ ...r, note: e.target.value }))}
            />
          </label>
        </section>
      )}
      <section className="card">
        <div className="row wrap between">
          <h2>{t("🗓️ Availability")}</h2>
          <span className={`small ${saveState === 'error' ? 'error' : 'muted'}`}>
            {saveState === 'saving' || Object.keys(pending).length ? t('Saving…') : saveState === 'error' ? t('Couldn’t save — retrying on next change') : `✓ ${t('Saved')}`}
          </span>
        </div>
        <p className="muted small">
          {me.memberId ? t('Edit your own column; everyone’s answers are visible.') : me.isHost ? t('Everyone’s answers are visible.') : t('Log in above to fill in your column.')}{' '}
          {t('Pick a tool, then tap or drag over cells.')}
        </p>
        <ul className="howto small">
          <li>{t('🚫 Can’t / avoid — ✕ means you can’t work that day; !!! / !! / ! mean you’d rather not (Wayneday tries hardest for !!!).')}</li>
          <li>
            {t('🔒 Lock in — you must work that day, on the shift slot you pick.')}
            {lockChoices.length > 1 ? ` (${lockChoices.map((s) => s.name).join(' / ')})` : ''}
          </li>
        </ul>
        {me.isHost && (
          <label className="check host-toggle">
            <input type="checkbox" checked={editOthers} onChange={(e) => setEditOthers(e.target.checked)} /> {t("Let me edit other people’s columns")} <span className="muted small">{t('(they’ll get a message with your reason)')}</span>
          </label>
        )}
        {me.isHost && editOthers && (
          <label className="host-reason">
            {t('Why are you changing their answers? (they’ll see this)')}
            <input
              value={reason}
              maxLength={500}
              onChange={(e) => {
                setReason(e.target.value)
                setNotice(null)
              }}
              placeholder={t('e.g. Too many people asked for the 14th off — I had to give you that night')}
              className={reason.trim() ? '' : 'needs'}
            />
          </label>
        )}
        <div className="row wrap toolbar">
          <div className="segmented" role="radiogroup" aria-label={t("Tool")}>
            <button role="radio" aria-checked={tool === 'mark'} className={tool === 'mark' ? 'on' : ''} onClick={() => setTool('mark')}>{t("🚫 Can’t / avoid")}</button>
            <button role="radio" aria-checked={tool === 'lock'} className={tool === 'lock' ? 'on' : ''} onClick={() => setTool('lock')}>{t("🔒 Lock in")}</button>
            <button role="radio" aria-checked={tool === 'clear'} className={tool === 'clear' ? 'on' : ''} onClick={() => setTool('clear')}>{t("🧽 Clear")}</button>
          </div>
          <button onClick={undo} disabled={undoCount === 0} title={t("Undo your last change")}>{t("↶ Undo")}</button>
          {tool === 'mark' && (
            <div className="segmented levels" role="radiogroup" aria-label={t("How much it matters")}>
              {([0, 3, 2, 1] as const).map((l) => (
                <button key={l} role="radio" aria-checked={markLvl === l} className={`${markLvl === l ? 'on' : ''} lvl-${l}`} onClick={() => setMarkLvl(l)}>
                  {l === 0 ? '✕' : '!'.repeat(l)} {t(MARK_LABEL[l])}
                </button>
              ))}
            </div>
          )}
          {tool === 'lock' && lockChoices.length > 1 && (
            <label className="inline">{t("into")} <select value={lockShift} onChange={(e) => setLockShift(e.target.value)}>
                {lockChoices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {notice && <p className="small warn-text">{notice}</p>}
        <Expandable title={t("🗓️ Availability")}>
        <div className="scroll-x grid-wrap">
          <table className="grid" onPointerDown={onDown} onPointerMove={onMove}>
            <thead>
              <tr>
                <th className="sticky">{t("Date")}</th>
                {members.map((m) => (
                  <th key={m.id} className={m.id === me.memberId ? 'me' : ''}>
                    <div className="colname">
                      {statusIcon(m.id)}
                      {m.name}
                    </div>
                    <div className="muted tiny">
                      {typeName(m.type)}
                      {session.responses[m.id]?.editedByHost ? t(" · host edited") : ''}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((date) => {
                const wd = weekday(date)
                const off = shiftsOn(config, date).length === 0
                const weekend = wd === 0 || wd === 6 || holidays.has(date)
                return (
                  <tr key={date} className={weekend ? 'weekend' : ''}>
                    <th className="sticky nowrap">
                      {shortDate(date)}
                      {holidays.has(date) && <span className="tiny"> ★</span>}
                    </th>
                    {members.map((m) => {
                      const st = cellState(respOf(m.id), date)
                      const editable = canEdit(m.id)
                      return (
                        <td
                          key={m.id}
                          data-date={date}
                          data-member={m.id}
                          className={`cell ${st.kind} ${st.kind === 'avoid' ? `avoid-${st.level}` : ''} ${editable ? 'editable' : ''} ${off ? 'off' : ''} ${m.id === me.memberId ? 'me' : ''}`}
                          title={`${m.name} · ${date}${
                            st.kind === 'lock'
                              ? ` · ${t('locked to {shift}', { shift: config.shifts.find((s) => s.id === st.shiftId)?.name ?? '' })}`
                              : st.kind === 'unavailable'
                                ? ` · ${t('Unavailable')}`
                                : st.kind === 'avoid'
                                  ? ` · ${t(AVOID_LABEL[st.level])}`
                                  : ''
                          }`}
                        >
                          {st.kind === 'unavailable'
                            ? '✕'
                            : st.kind === 'lock'
                              ? `🔒${config.shifts.length > 1 ? shiftShort(st.shiftId) : ''}`
                              : st.kind === 'avoid'
                                ? '!'.repeat(st.level)
                                : ''}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        </Expandable>
      </section>
      {mine && me.memberId && (
        <section className={`card ready-card ${mine.ready ? 'is-ready' : ''}`}>
          {mine.ready ? (
            <>
              <h2>✅ {t('You’re ready!')}</h2>
              <p className="muted small">
                {t('The host can see you’ve finished ({time}). You can still change your answers until the roster is made.', {
                  time: new Date(mine.ready).toLocaleString(),
                })}
              </p>
              <button type="button" className="link" disabled={!canEdit(me.memberId)} onClick={() => setPref((r) => ({ ...r, ready: undefined }))}>
                {t('Not ready yet — I’m still filling in')}
              </button>
            </>
          ) : (
            <>
              <h2>🏁 {t('Finished?')}</h2>
              <p className="muted small">{t('Mark the days you can’t do or would rather avoid above, then press this so the host knows you’re done.')}</p>
              <button type="button" className="primary big" disabled={!canEdit(me.memberId)} onClick={() => setPref((r) => ({ ...r, ready: Date.now() }))}>
                ✅ {t('I’m ready!')}
              </button>
            </>
          )}
        </section>
      )}
      <section className="card">
        <div className="row wrap between">
          <h2>👥 {t('Everyone’s answers')}</h2>
          <span className="small status-legend">
            {(['ready', 'filling', 'away'] as const).map((k) => (
              <span key={k}>
                {STATUS[k].icon} {t(STATUS[k].label, { n: answering.filter((m) => statusOf(m.id) === k).length })}
              </span>
            ))}
          </span>
        </div>
        {me.isHost && editOthers && !reason.trim() && <p className="small warn-text">{t('To change someone’s pattern or interval here, write your reason above the calendar first.')}</p>}
        <div className="scroll-x table-wrap first-sticky">
          <table className="mini">
            <thead>
              <tr>
                <th>{t("Name")}</th>
                <th>{t("Pattern")}</th>
                <th>{t("Min interval")}</th>
                <th>{t("Unavailable")}</th>
                <th>{t("Avoid")}</th>
                <th>{t("Locked")}</th>
                <th>{t("Note")}</th>
                <th>{t("Updated")}</th>
                {me.isHost && <th>{t('Notes')}</th>}
              </tr>
            </thead>
            <tbody>
              {answering.map((m) => {
                const answered = Boolean(session.responses[m.id])
                const r = respOf(m.id)
                const notes = session.notes.filter((n) => n.memberId === m.id)
                return (
                  <Fragment key={m.id}>
                  <tr className={m.id === me.memberId ? 'me' : ''}>
                    <td className="nowrap">
                      {statusIcon(m.id)}
                      {m.name} <span className="muted tiny">{typeName(m.type)}</span>
                    </td>
                    {answered || pending[m.id] || hostEditing(m.id) ? (
                      <>
                        {hostEditing(m.id) ? (
                          <>
                            <td>
                              <select
                                aria-label={t('Shift pattern')}
                                value={r.preference}
                                onChange={(e) => editAnswer(m.id, (x) => ({ ...x, preference: e.target.value as MemberResponse['preference'] }))}
                              >
                                <option value="distributed">{t('Spread out')}</option>
                                <option value="dense">{t('Grouped')}</option>
                              </select>
                            </td>
                            <td>
                              <input
                                type="number"
                                min={1}
                                max={60}
                                aria-label={t('Min interval')}
                                value={r.minInterval}
                                onChange={(e) => editAnswer(m.id, (x) => ({ ...x, minInterval: Math.max(1, Number(e.target.value) || 1) }))}
                              />
                            </td>
                          </>
                        ) : (
                          <>
                            <td>{r.preference === 'distributed' ? t("Spread out") : t("Grouped")}</td>
                            <td>{t("{n} d", { n: r.minInterval })}</td>
                          </>
                        )}
                        <td>{r.unavailable.length}</td>
                        <td>{r.avoid?.length ?? 0}</td>
                        <td>{r.locks.length}</td>
                        <td className="note">{r.note}</td>
                        <td className="muted small nowrap">{r.updatedAt ? new Date(r.updatedAt).toLocaleString() : t("now")}</td>
                      </>
                    ) : (
                      <td colSpan={7} className="muted small">{t("No answer yet — defaults: spread out,")} {r.minInterval}{t("-day interval")}</td>
                    )}
                    {me.isHost && (
                      <td>
                        <button
                          type="button"
                          className="link nowrap"
                          aria-expanded={notesFor === m.id}
                          title={t('Leave {name} a note — only they and the hosts can see it', { name: m.name })}
                          onClick={() => setNotesFor(notesFor === m.id ? null : m.id)}
                        >
                          💬 {notes.length || ''}
                          {notes.some((n) => !n.readAt) && <span className="muted small"> {t('({n} unseen)', { n: notes.filter((n) => !n.readAt).length })}</span>}
                        </button>
                      </td>
                    )}
                  </tr>
                  {me.isHost && notesFor === m.id && (
                    <tr className="notes-row">
                      <td colSpan={10}>
                        <HostNotes
                          name={m.name}
                          notes={notes}
                          send={(text) => mutate(() => api.addNote(code, m.id, text))}
                          remove={(id) => void mutate(() => api.removeNote(code, id))}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {session.changes.length > 0 && <ChangeLog changes={session.changes} nameOf={nameOf} canRevert={me.isHost} revert={(c) => update(c.memberId, () => c.before ?? DEFAULT_RESPONSE)} />}
      </section>
    </div>
  );
}

/** A host's notes to one member: what was sent and whether they've seen it, and a box for a new one. */
function HostNotes({ name, notes, send, remove }: { name: string; notes: HostNote[]; send: (text: string) => Promise<unknown>; remove: (id: string) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="host-notes stack-tight">
      {notes.map((n) => (
        <div key={n.id} className="host-note small">
          <span className="note-text">{n.text}</span>{' '}
          <span className="muted">
            · {new Date(n.at).toLocaleString()} · {n.readAt ? t('✓ seen') : t('not seen yet')}
          </span>{' '}
          <button type="button" className="x" aria-label={t('Delete')} onClick={() => remove(n.id)}>
            ×
          </button>
        </div>
      ))}
      <div className="row wrap align-end">
        <label className="grow small">
          {t('Note to {name} (only they and the hosts see it)', { name })}
          <textarea rows={2} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder={t('e.g. Please mark your exam dates too')} />
        </label>
        <button
          type="button"
          className="primary"
          disabled={!text.trim() || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await send(text)
              setText('')
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('Send')}
        </button>
      </div>
    </div>
  )
}

function ChangeLog({
  changes,
  nameOf,
  canRevert,
  revert,
}: {
  changes: AnswerChange[]
  nameOf: (id: string) => string
  canRevert: boolean
  revert: (c: AnswerChange) => void
}) {
  return (
    <details className="history">
      <summary className="small">{t("Host edits to people’s answers (")}{changes.length})</summary>
      <ul>
        {[...changes].reverse().slice(0, 30).map((c) => (
          <li key={c.id} className="small">
            <span className="muted">{new Date(c.at).toLocaleString()}</span> · {nameOf(c.memberId)}: {c.summary}
            {c.reason && <span className="muted"> — “{c.reason}”</span>}{' '}
            {canRevert && (
              <button className="link" onClick={() => revert(c)}>{t("revert")}</button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
