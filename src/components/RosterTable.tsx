import type { Ref } from 'react'
import { columnsFor } from '../export.ts'
import { dateRange, shortDate, weekday } from '../shared/dates.ts'
import type { Assignment, Concern, SessionConfig } from '../shared/types.ts'

interface Props {
  config: SessionConfig
  assignments: Assignment[]
  myId: string | null
  /** Host manual editing. */
  onEdit?: (date: string, shiftId: string, requirementId: string, slot: number, memberId: string) => void
  /** Member clicks a cell to raise a concern about it. */
  onPick?: (date: string, shiftId: string) => void
  concerns?: Concern[]
  tableRef?: Ref<HTMLDivElement>
}

export default function RosterTable({ config, assignments, myId, onEdit, onPick, concerns = [], tableRef }: Props) {
  const cols = columnsFor(config)
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  const holidays = new Set(config.holidays)
  const open = concerns.filter((c) => !c.resolved && c.date)

  return (
    <div className="scroll-x" ref={tableRef}>
      <table className="roster">
        <thead>
          <tr>
            <th className="sticky">Date</th>
            {cols.map((c) => (
              <th key={c.requirementId}>{c.title}</th>
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
                </th>
                {cols.map((c) => {
                  const shift = config.shifts.find((s) => s.id === c.shiftId)!
                  if (!shift.days.includes(wd)) return <td key={c.requirementId} className="off" />
                  const req = shift.requirements.find((r) => r.id === c.requirementId)!
                  const here = assignments.filter((a) => a.date === date && a.shiftId === c.shiftId && a.requirementId === c.requirementId)
                  const flagged = open.some((x) => x.date === date && (!x.shiftId || x.shiftId === c.shiftId))
                  const candidates = config.members.filter(
                    (m) => (req.memberType === 'any' || m.type === req.memberType) && (m.jobs.length === 0 || m.jobs.includes(req.jobId)),
                  )
                  return (
                    <td
                      key={c.requirementId}
                      className={`${flagged ? 'flagged' : ''} ${onPick ? 'pickable' : ''}`}
                      onClick={onPick ? () => onPick(date, c.shiftId) : undefined}
                    >
                      {Array.from({ length: req.count }, (_, k) => {
                        const a = here[k]
                        if (onEdit) {
                          return (
                            <select
                              key={k}
                              className="cell-select"
                              value={a?.memberId ?? ''}
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
                            {a ? name(a.memberId) : 'unfilled'}
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
