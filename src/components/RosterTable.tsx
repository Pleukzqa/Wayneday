import type { Ref } from 'react'
import { cellIds, cellNames, columnsFor } from '../export.ts'
import { reqCount } from '../shared/calendar.ts'
import { dateRange, shortDate, weekday } from '../shared/dates.ts'
import { STUDENT_SLOT, type Concern, type Roster, type SessionConfig, type SwapRequest } from '../shared/types.ts'

interface Props {
  config: SessionConfig
  roster: Roster
  myId: string | null
  /** Host manual editing of resident/staff positions. */
  onEdit?: (date: string, shiftId: string, requirementId: string, slot: number, memberId: string) => void
  /** Host manual editing of students on a shift. */
  onEditStudent?: (date: string, shiftId: string, slot: number, memberId: string, requirementId?: string) => void
  /** Tap on a cell (to raise a concern or ask for a swap). requirementId is STUDENT_SLOT for the students column. */
  onPick?: (date: string, shiftId: string, requirementId: string | null) => void
  concerns?: Concern[]
  swaps?: SwapRequest[]
  tableRef?: Ref<HTMLDivElement>
}

export default function RosterTable({ config, roster, myId, onEdit, onEditStudent, onPick, concerns = [], swaps = [], tableRef }: Props) {
  const studentList = config.members.filter((m) => m.type === 'student')
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
              <th key={c.key} className={c.kind === 'duty' ? 'duty-col' : c.kind !== 'position' ? 'extra-col' : ''}>
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
                  const ids = cellIds(config, roster, c, date) ?? []
                  const studentCol = c.kind === 'students' || c.kind === 'place'
                  const placeReq = c.kind === 'place' ? c.requirementId : undefined
                  if (studentCol && onEditStudent) {
                    const shift = config.shifts.find((x) => x.id === c.shiftId)!
                    const req = shift.requirements.find((r) => r.id === placeReq)
                    const slots = req ? reqCount(config, shift, req, date) : config.students.maxPerShift
                    return (
                      <td key={c.key} className="extra-col">
                        {Array.from({ length: Math.max(slots, ids.length) }, (_, k) => (
                          <select
                            key={k}
                            className="cell-select"
                            value={ids[k] ?? ''}
                            aria-label={`${shortDate(date)} ${c.title}`}
                            onChange={(e) => onEditStudent(date, c.shiftId, k, e.target.value, placeReq)}
                          >
                            <option value="">—</option>
                            {studentList.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        ))}
                      </td>
                    )
                  }
                  if (c.kind !== 'position') {
                    return (
                      <td
                        key={c.key}
                        className={`${c.kind === 'duty' ? 'duty-col' : 'extra-col'} ${studentCol && onPick ? 'pickable' : ''} ${
                          studentCol && swapOpen.some((s) => s.requirementId === STUDENT_SLOT && s.date === date && s.shiftId === c.shiftId) ? 'swapping' : ''
                        }`}
                        onClick={studentCol && onPick ? () => onPick(date, c.shiftId, STUDENT_SLOT) : undefined}
                      >
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

