import type { Ref } from 'react'
import { cellNames, columnsFor } from '../export.ts'
import { reqCount } from '../shared/calendar.ts'
import { dateRange, shortDate, weekday } from '../shared/dates.ts'
import type { Concern, Roster, SessionConfig, SwapRequest } from '../shared/types.ts'

interface Props {
  config: SessionConfig
  roster: Roster
  myId: string | null
  /** Host manual editing of resident/staff positions. */
  onEdit?: (date: string, shiftId: string, requirementId: string, slot: number, memberId: string) => void
  /** Tap on a cell (to raise a concern or ask for a swap). */
  onPick?: (date: string, shiftId: string, requirementId: string | null) => void
  concerns?: Concern[]
  swaps?: SwapRequest[]
  tableRef?: Ref<HTMLDivElement>
}

export default function RosterTable({ config, roster, myId, onEdit, onPick, concerns = [], swaps = [], tableRef }: Props) {
  const cols = columnsFor(config)
  const holidays = new Set(config.holidays)
  const open = concerns.filter((c) => !c.resolved && c.date)
  const swapOpen = swaps.filter((s) => s.status === 'open' || s.status === 'agreed')
  const nameOf = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'

  return (
    <div className="scroll-x" ref={tableRef}>
      <table className="roster">
        <thead>
          <tr>
            <th className="sticky">Date</th>
            {cols.map((c) => (
              <th key={c.key} className={c.kind !== 'position' ? 'extra-col' : ''}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dateRange(config.startDate, config.endDate).map((date) => {
            const wd = weekday(date)
            const weekend = wd === 0 || wd === 6 || holidays.has(date)
            return (
              <tr key={date} className={weekend ? 'weekend' : ''}>
                <th className="sticky nowrap">
                  {shortDate(date)}
                  {holidays.has(date) && <span className="tiny"> ★</span>}
                  {config.overrides.some((o) => o.date === date) && <span className="tiny" title="Changed from the weekly pattern"> ✎</span>}
                </th>
                {cols.map((c) => {
                  const names = cellNames(config, roster, c, date)
                  if (names === null) return <td key={c.key} className="off" />
                  if (c.kind !== 'position') {
                    const ids =
                      c.kind === 'students'
                        ? roster.students.filter((s) => s.date === date && s.shiftId === c.shiftId).map((s) => s.memberId)
                        : roster.presenters.filter((p) => p.date === date && p.ruleId === c.ruleId).map((p) => p.memberId)
                    return (
                      <td key={c.key} className="extra-col">
                        {ids.length === 0 && <span className="muted tiny">—</span>}
                        {ids.map((id, k) => (
                          <span key={k} className={`who-chip small-chip ${id === myId ? 'mine' : ''}`}>
                            {nameOf(id)}
                            {c.kind === 'presenters' &&
                              roster.presenters.find((p) => p.date === date && p.ruleId === c.ruleId && p.memberId === id)?.postCall && (
                                <span title="Was on last night’s shift"> ●</span>
                              )}
                          </span>
                        ))}
                      </td>
                    )
                  }
                  const shift = config.shifts.find((s) => s.id === c.shiftId)!
                  const req = shift.requirements.find((r) => r.id === c.requirementId)!
                  const here = roster.assignments.filter((a) => a.date === date && a.shiftId === c.shiftId && a.requirementId === c.requirementId)
                  const slots = Math.max(here.length, reqCount(config, shift, req, date))
                  const flagged = open.some((x) => x.date === date && (!x.shiftId || x.shiftId === c.shiftId))
                  const swapping = swapOpen.some((s) => s.date === date && s.shiftId === c.shiftId && s.requirementId === c.requirementId)
                  const candidates = config.members.filter(
                    (m) =>
                      m.type !== 'student' &&
                      (req.memberType === 'any' || m.type === req.memberType) &&
                      (m.jobs.length === 0 || m.jobs.includes(req.jobId)),
                  )
                  return (
                    <td
                      key={c.key}
                      className={`${flagged ? 'flagged' : ''} ${swapping ? 'swapping' : ''} ${onPick ? 'pickable' : ''}`}
                      onClick={onPick ? () => onPick(date, c.shiftId, c.requirementId) : undefined}
                    >
                      {Array.from({ length: Math.max(1, slots) }, (_, k) => {
                        const a = here[k]
                        if (onEdit) {
                          return (
                            <select
                              key={k}
                              className="cell-select"
                              value={a?.memberId ?? ''}
                              aria-label={`${shortDate(date)} ${c.title}`}
                              onChange={(e) => onEdit(date, c.shiftId, c.requirementId, k, e.target.value)}
                            >
                              <option value="">—</option>
                              {candidates.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </select>
                          )
                        }
                        return (
                          <span key={k} className={`who-chip ${a?.memberId === myId ? 'mine' : ''} ${a ? '' : 'empty'}`}>
                            {a ? nameOf(a.memberId) : 'unfilled'}
                            {a && swapOpen.some((s) => s.memberId === a.memberId && s.date === date && s.shiftId === c.shiftId) && (
                              <span title="Swap requested"> ⇄</span>
                            )}
                          </span>
                        )
                      })}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

