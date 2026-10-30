import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../api.ts'
import { shiftRuns, shiftsForType, shiftsOn } from '../shared/calendar.ts'
import { dateRange, shortDate, weekday } from '../shared/dates.ts'
import { responseFor } from '../shared/solver.ts'
import { DEFAULT_RESPONSE, type AnswerChange, type AvoidLevel, type MemberResponse } from '../shared/types.ts'
import type { SessionProps } from './props.ts'

type Tool = 'unavailable' | 'avoid' | 'lock' | 'clear'

const AVOID_LABEL = ['', 'Rather not', 'Important', 'Really need off']

export default function AvailabilityTab({ code, session, me, mutate }: SessionProps) {
  const { config } = session
  const [pending, setPending] = useState<Record<string, MemberResponse>>({})
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [tool, setTool] = useState<Tool>('unavailable')
  const [editOthers, setEditOthers] = useState(false)
  const [avoidLvl, setAvoidLvl] = useState<AvoidLevel>(3)
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
          await mutate(() => api.saveResponse(code, memberId, r))
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
    [code, mutate, session.responses],
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

  function apply(memberId: string, date: string, mode: Tool) {
    if (!canEdit(memberId)) return
    const shift = config.shifts.find((s) => s.id === lockShift)
    if (mode === 'lock') {
      const member = config.members.find((m) => m.id === memberId)!
      if (!shift || !shiftRuns(config, shift, date)) return setNotice(`${shift?.name ?? 'That shift'} doesn’t run on ${shortDate(date)}.`)
      if (!shiftsForType(config, member.type).some((s) => s.id === shift.id)) {
        return setNotice(`${member.name} (${member.type}) can’t be locked into ${shift.name} — it has no ${member.type} places.`)
      }
    }
    setNotice(null)
    remember(memberId)
    update(memberId, (r) => {
      const unavailable = r.unavailable.filter((d) => d !== date)
      const locks = r.locks.filter((l) => l.date !== date)
      const avoid = (r.avoid ?? []).filter((a) => a.date !== date)
      if (mode === 'avoid') avoid.push({ date, level: avoidLvl })
      if (mode === 'unavailable') unavailable.push(date)
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
      (tool === 'unavailable' && st.kind === 'unavailable') ||
      (tool === 'lock' && st.kind === 'lock' && st.shiftId === lockShift) ||
      (tool === 'avoid' && st.kind === 'avoid' && st.level === avoidLvl)
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
        (want === 'unavailable' && st.kind === 'unavailable') ||
        (want === 'lock' && st.kind === 'lock' && st.shiftId === lockShift) ||
        (want === 'avoid' && st.kind === 'avoid' && st.level === avoidLvl)
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
    ? [...session.changes].reverse().find((c) => c.memberId === me.memberId && c.at > ack && !me.isHost)
    : undefined
  const nameOf = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'

  if (config.members.length === 0) {
    return <p className="muted">The host hasn't added anyone yet.</p>
  }
  if (members.length === 0) {
    return <p className="muted">No students yet. Residents and staff come from the hospital roster, so only students fill in this page.</p>
  }

  return (
    <div className="stack">
      {hostChange && (
        <div className="alert warn" role="status">
          <strong>The host changed your answers</strong> ({new Date(hostChange.at).toLocaleString()}): {hostChange.summary}.
          <div className="row wrap">
            <button
              onClick={() => {
                update(me.memberId!, () => hostChange.before ?? DEFAULT_RESPONSE)
                acknowledge(hostChange.at)
              }}
            >
              Restore my previous answers
            </button>
            <button className="link" onClick={() => acknowledge(hostChange.at)}>
              Keep the change
            </button>
          </div>
        </div>
      )}
      {hospital && me.memberId && !iAnswer && (
        <p className="muted small">Your shifts come from the hospital roster, so there’s nothing for you to fill in here. Students’ answers are below.</p>
      )}
      {mine && me.memberId && (
        <section className="card">
          <h2>My preferences</h2>
          <div className="row wrap">
            <div className="segmented" role="radiogroup" aria-label="Shift pattern">
              {(
                [
                  ['distributed', 'Spread out', 'Shifts evenly spaced across the period'],
                  ['dense', 'Grouped', 'Shifts close together, at your minimum interval'],
                ] as const
              ).map(([v, t, hint]) => (
                <button
                  key={v}
                  role="radio"
                  aria-checked={mine.preference === v}
                  className={mine.preference === v ? 'on' : ''}
                  title={hint}
                  disabled={!canEdit(me.memberId!)}
                  onClick={() => setPref((r) => ({ ...r, preference: v }))}
                >
                  {t}
                </button>
              ))}
            </div>
            <label className="inline">
              At least
              <input
                type="number"
                min={1}
                max={60}
                value={mine.minInterval}
                disabled={!canEdit(me.memberId)}
                onChange={(e) => setPref((r) => ({ ...r, minInterval: Math.max(1, Number(e.target.value) || 1) }))}
              />
              days between shifts
            </label>
          </div>
          <p className="muted small">
            {mine.minInterval === 1 ? 'Consecutive days are OK.' : `e.g. a shift on the 1st means the next is the ${mine.minInterval + 1}th at the earliest.`}{' '}
            Spread-out preferences are given priority; grouped shifts are packed as close as your interval allows.
          </p>
          <label>
            Note for the host
            <input
              value={mine.note}
              disabled={!canEdit(me.memberId)}
              placeholder="e.g. exam on the 14th, prefer no Fridays"
              onChange={(e) => update(me.memberId!, (r) => ({ ...r, note: e.target.value }))}
            />
          </label>
        </section>
      )}

      <section className="card">
        <div className="row wrap between">
          <h2>Availability</h2>
          <span className={`small ${saveState === 'error' ? 'error' : 'muted'}`}>
            {saveState === 'saving' || Object.keys(pending).length ? 'Saving…' : saveState === 'error' ? 'Couldn’t save — retrying on next change' : 'Saved'}
          </span>
        </div>
        <p className="muted small">
          {me.memberId ? 'Edit your own column; everyone’s answers are visible.' : me.isHost ? 'Everyone’s answers are visible.' : 'Log in above to fill in your column.'}{' '}
          Tap or drag over cells. <strong>Unavailable</strong> = you can’t work that day. <strong>Avoid</strong> = you’d rather not, in
          three levels (!!! really need it off, !! important, ! rather not) — Wayneday tries hardest for !!!. <strong>Lock in</strong> = you must work
          that day, on the shift slot you pick
          {lockChoices.length > 1 ? ` (${lockChoices.map((s) => s.name).join(' or ')})` : ''}.
        </p>
        {me.isHost && (
          <label className="check host-toggle">
            <input type="checkbox" checked={editOthers} onChange={(e) => setEditOthers(e.target.checked)} />
            Let me edit other people’s columns
            <span className="muted small">(they’ll be told, and can restore their answers)</span>
          </label>
        )}
        <div className="row wrap toolbar">
          <div className="segmented" role="radiogroup" aria-label="Tool">
            <button role="radio" aria-checked={tool === 'unavailable'} className={tool === 'unavailable' ? 'on' : ''} onClick={() => setTool('unavailable')}>
              <span className="swatch unavail">✕</span> Unavailable
            </button>
            <button role="radio" aria-checked={tool === 'lock'} className={tool === 'lock' ? 'on' : ''} onClick={() => setTool('lock')}>
              <span className="swatch lock">🔒</span> Lock in
            </button>
            <button role="radio" aria-checked={tool === 'avoid'} className={tool === 'avoid' ? 'on' : ''} onClick={() => setTool('avoid')}>
              <span className="swatch avoid">!</span> Avoid
            </button>
            <button role="radio" aria-checked={tool === 'clear'} className={tool === 'clear' ? 'on' : ''} onClick={() => setTool('clear')}>
              Clear
            </button>
          </div>
          <button onClick={undo} disabled={undoCount === 0} title="Undo your last change">
            ↶ Undo
          </button>
          {tool === 'avoid' && (
            <div className="segmented" role="radiogroup" aria-label="How much it matters">
              {([3, 2, 1] as const).map((l) => (
                <button key={l} role="radio" aria-checked={avoidLvl === l} className={`${avoidLvl === l ? 'on' : ''} lvl-${l}`} onClick={() => setAvoidLvl(l)}>
                  {'!'.repeat(l)} {AVOID_LABEL[l]}
                </button>
              ))}
            </div>
          )}
          {tool === 'lock' && lockChoices.length > 1 && (
            <label className="inline">
              into
              <select value={lockShift} onChange={(e) => setLockShift(e.target.value)}>
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
        <div className="scroll-x grid-wrap">
          <table className="grid" onPointerDown={onDown} onPointerMove={onMove}>
            <thead>
              <tr>
                <th className="sticky">Date</th>
                {members.map((m) => (
                  <th key={m.id} className={m.id === me.memberId ? 'me' : ''}>
                    <div className="colname">{m.name}</div>
                    <div className="muted tiny">
                      {m.type}
                      {session.responses[m.id]?.editedByHost ? ' · host edited' : ''}
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
                              ? ` · locked to ${config.shifts.find((s) => s.id === st.shiftId)?.name}`
                              : st.kind === 'unavailable'
                                ? ' · unavailable'
                                : st.kind === 'avoid'
                                  ? ` · avoid: ${AVOID_LABEL[st.level]}`
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
      </section>

      <section className="card">
        <h2>Everyone’s answers</h2>
        <div className="scroll-x">
          <table className="mini">
            <thead>
              <tr>
                <th>Name</th>
                <th>Pattern</th>
                <th>Min interval</th>
                <th>Unavailable</th>
                <th>Avoid</th>
                <th>Locked</th>
                <th>Note</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {answering.map((m) => {
                const answered = Boolean(session.responses[m.id])
                const r = respOf(m.id)
                return (
                  <tr key={m.id} className={m.id === me.memberId ? 'me' : ''}>
                    <td className="nowrap">
                      {m.name} <span className="muted tiny">{m.type}</span>
                    </td>
                    {answered || pending[m.id] ? (
                      <>
                        <td>{r.preference === 'distributed' ? 'Spread out' : 'Grouped'}</td>
                        <td>{r.minInterval} d</td>
                        <td>{r.unavailable.length}</td>
                        <td>{r.avoid?.length ?? 0}</td>
                        <td>{r.locks.length}</td>
                        <td className="note">{r.note}</td>
                        <td className="muted small nowrap">{r.updatedAt ? new Date(r.updatedAt).toLocaleString() : 'now'}</td>
                      </>
                    ) : (
                      <td colSpan={7} className="muted small">
                        No answer yet — defaults: spread out, {r.minInterval}-day interval
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {session.changes.length > 0 && <ChangeLog changes={session.changes} nameOf={nameOf} canRevert={me.isHost} revert={(c) => update(c.memberId, () => c.before ?? DEFAULT_RESPONSE)} />}
      </section>
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
      <summary className="small">Host edits to people’s answers ({changes.length})</summary>
      <ul>
        {[...changes].reverse().slice(0, 30).map((c) => (
          <li key={c.id} className="small">
            <span className="muted">{new Date(c.at).toLocaleString()}</span> · {nameOf(c.memberId)}: {c.summary}{' '}
            {canRevert && (
              <button className="link" onClick={() => revert(c)}>
                revert
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}
