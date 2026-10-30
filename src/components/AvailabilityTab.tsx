import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../api.ts'
import { dateRange, shortDate, weekday } from '../shared/dates.ts'
import { responseFor } from '../shared/solver.ts'
import type { MemberResponse } from '../shared/types.ts'
import type { SessionProps } from './props.ts'

type Tool = 'unavailable' | 'lock' | 'clear'

export default function AvailabilityTab({ code, session, me, mutate }: SessionProps) {
  const { config } = session
  const [pending, setPending] = useState<Record<string, MemberResponse>>({})
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [tool, setTool] = useState<Tool>('unavailable')
  const [chosenLockShift, setLockShift] = useState('')
  const lockShift = config.shifts.some((s) => s.id === chosenLockShift) ? chosenLockShift : (config.shifts[0]?.id ?? '')
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const latest = useRef(pending)
  useEffect(() => {
    latest.current = pending
  })

  const respOf = useCallback(
    (memberId: string) => pending[memberId] ?? responseFor(session.responses, memberId),
    [pending, session.responses],
  )
  const canEdit = (memberId: string) => (me.isHost || me.memberId === memberId) && session.schedule?.status !== 'final'

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
    return lock ? { kind: 'lock' as const, shiftId: lock.shiftId } : { kind: 'free' as const }
  }

  function apply(memberId: string, date: string, mode: Tool) {
    if (!canEdit(memberId)) return
    const shift = config.shifts.find((s) => s.id === lockShift)
    if (mode === 'lock' && !shift?.days.includes(weekday(date))) return
    update(memberId, (r) => {
      const unavailable = r.unavailable.filter((d) => d !== date)
      const locks = r.locks.filter((l) => l.date !== date)
      if (mode === 'unavailable') unavailable.push(date)
      if (mode === 'lock') locks.push({ date, shiftId: lockShift })
      return { ...r, unavailable, locks }
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
    const same = (tool === 'unavailable' && st.kind === 'unavailable') || (tool === 'lock' && st.kind === 'lock' && st.shiftId === lockShift)
    const mode: Tool = same ? 'clear' : tool
    paint.current = { mode }
    apply(c.memberId, c.date, mode)
    e.preventDefault()
  }
  function onMove(e: ReactPointerEvent) {
    if (!paint.current || e.pointerType === 'touch') return
    const c = cellAt(e.clientX, e.clientY)
    if (c) {
      const st = cellState(respOf(c.memberId), c.date)
      const want = paint.current.mode
      const already = (want === 'clear' && st.kind === 'free') || (want === 'unavailable' && st.kind === 'unavailable') || (want === 'lock' && st.kind === 'lock' && st.shiftId === lockShift)
      if (!already) apply(c.memberId, c.date, want)
    }
  }
  useEffect(() => {
    const up = () => (paint.current = null)
    addEventListener('pointerup', up)
    return () => removeEventListener('pointerup', up)
  }, [])

  const days = dateRange(config.startDate, config.endDate)
  const members = [...config.members].sort((a, b) => Number(b.id === me.memberId) - Number(a.id === me.memberId))
  const mine = me.memberId ? respOf(me.memberId) : null
  const holidays = new Set(config.holidays)
  const shiftShort = (id: string) => config.shifts.find((s) => s.id === id)?.name.slice(0, 3) ?? '?'

  if (config.members.length === 0) {
    return <p className="muted">The host hasn't added anyone yet.</p>
  }

  return (
    <div className="stack">
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
                  onClick={() => update(me.memberId!, (r) => ({ ...r, preference: v }))}
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
                onChange={(e) => update(me.memberId!, (r) => ({ ...r, minInterval: Math.max(1, Number(e.target.value) || 1) }))}
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
          {me.isHost ? 'As host you can edit anyone’s column.' : me.memberId ? 'Edit your own column; everyone’s answers are visible.' : 'Log in above to fill in your column.'}{' '}
          Tap or drag over cells.
        </p>
        <div className="row wrap toolbar">
          <div className="segmented" role="radiogroup" aria-label="Tool">
            <button role="radio" aria-checked={tool === 'unavailable'} className={tool === 'unavailable' ? 'on' : ''} onClick={() => setTool('unavailable')}>
              <span className="swatch unavail">✕</span> Unavailable
            </button>
            <button role="radio" aria-checked={tool === 'lock'} className={tool === 'lock' ? 'on' : ''} onClick={() => setTool('lock')}>
              <span className="swatch lock">🔒</span> Lock in
            </button>
            <button role="radio" aria-checked={tool === 'clear'} className={tool === 'clear' ? 'on' : ''} onClick={() => setTool('clear')}>
              Clear
            </button>
          </div>
          {tool === 'lock' && config.shifts.length > 1 && (
            <label className="inline">
              to
              <select value={lockShift} onChange={(e) => setLockShift(e.target.value)}>
                {config.shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="scroll-x grid-wrap">
          <table className="grid" onPointerDown={onDown} onPointerMove={onMove}>
            <thead>
              <tr>
                <th className="sticky">Date</th>
                {members.map((m) => (
                  <th key={m.id} className={m.id === me.memberId ? 'me' : ''}>
                    <div className="colname">{m.name}</div>
                    <div className="muted tiny">{m.type}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((date) => {
                const wd = weekday(date)
                const off = !config.shifts.some((s) => s.days.includes(wd))
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
                          className={`cell ${st.kind} ${editable ? 'editable' : ''} ${off ? 'off' : ''} ${m.id === me.memberId ? 'me' : ''}`}
                          title={`${m.name} · ${date}${st.kind === 'lock' ? ` · locked to ${config.shifts.find((s) => s.id === st.shiftId)?.name}` : st.kind === 'unavailable' ? ' · unavailable' : ''}`}
                        >
                          {st.kind === 'unavailable' ? '✕' : st.kind === 'lock' ? `🔒${config.shifts.length > 1 ? shiftShort(st.shiftId) : ''}` : ''}
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
                <th>Locked</th>
                <th>Note</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {config.members.map((m) => {
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
                        <td>{r.locks.length}</td>
                        <td className="note">{r.note}</td>
                        <td className="muted small nowrap">{r.updatedAt ? new Date(r.updatedAt).toLocaleString() : 'now'}</td>
                      </>
                    ) : (
                      <td colSpan={6} className="muted small">
                        No answer yet — defaults: spread out, {r.minInterval}-day interval
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
