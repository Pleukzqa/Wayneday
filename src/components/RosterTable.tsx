import type { Ref } from 'react'
import { t } from '../shared/i18n.ts'
import { cellIds, cellNames, columnsFor, presenterParts } from '../shared/columns.ts'
import { reqCount } from '../shared/calendar.ts'
import { dateRange, shortDate, weekday } from '../shared/dates.ts'
import { placeKey } from '../shared/students.ts'
import { coversJob, STUDENT_SLOT, type Concern, type Roster, type SessionConfig, type StudentAssignment, type SwapRequest } from '../shared/types.ts'

interface Props {
  config: SessionConfig
  roster: Roster
  myId: string | null
  /** How much a student asked to avoid a date (0 = not at all, 1–3 = ! to !!!): those shifts are marked. */
  avoidOf?: (memberId: string, date: string) => number
  /** Host manual editing of resident/staff positions. */
  onEdit?: (date: string, shiftId: string, requirementId: string, slot: number, memberId: string) => void
  /** Host manual editing of students on a shift. */
  onEditStudent?: (date: string, shiftId: string, slot: number, memberId: string, requirementId?: string) => void
  /** Tap on a cell (to raise a concern or ask for a swap). requirementId is STUDENT_SLOT for the students column. */
  onPick?: (date: string, shiftId: string, requirementId: string | null) => void
  concerns?: Concern[]
  swaps?: SwapRequest[]
  tableRef?: Ref<HTMLDivElement>
  /** Host hand-arranging students in a preview. */
  arrange?: Arrange
}

export interface Arrange {
  picked: StudentAssignment | null
  /** Place keys the picked student can move to without breaking a rule. */
  moves: Set<string>
  /** `${placeKey}|${memberId}` of students the picked one can trade places with. */
  swaps: Set<string>
  /** Place key -> problems, for places the host changed. */
  issues: Map<string, string[]>
  /** Place keys that differ from the option the host started from. */
  changed: Set<string>
  onChip: (s: StudentAssignment) => void
  onPlace: (date: string, shiftId: string, requirementId?: string) => void
}

export default function RosterTable({ config, roster, myId, avoidOf, onEdit, onEditStudent, onPick, concerns = [], swaps = [], tableRef, arrange }: Props) {
  const studentList = config.members.filter((m) => m.type === 'student')
  const cols = columnsFor(config)
  const holidays = new Set(config.holidays)
  const open = concerns.filter((c) => !c.resolved && c.date)
  const swapOpen = swaps.filter((s) => s.status === 'open' || s.status === 'agreed')
  const nameOf = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  // A shift on a day the student asked to avoid: marked with its level.
  const avoided = (id: string, date: string) => avoidOf?.(id, date) ?? 0
  const avoidMark = (id: string, date: string) =>
    avoided(id, date) > 0 && (
      <span className="avoid-mark" title={t('{name} asked to avoid this day ({level})', { name: nameOf(id), level: '!'.repeat(avoided(id, date)) })}>
        {' '}
        {'!'.repeat(avoided(id, date))}
      </span>
    )

  return (
    <div className="scroll-x" ref={tableRef}>
      <table className="roster">
        <thead>
          <tr>
            <th className="sticky">{t("Date")}</th>
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
                  {config.overrides.some((o) => o.date === date) && <span className="tiny" title={t("Changed from the weekly pattern")}> ✎</span>}
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
                  if (studentCol && arrange) {
                    const key = placeKey({ date, shiftId: c.shiftId, requirementId: placeReq })
                    const here = roster.students.filter((x) => x.date === date && x.shiftId === c.shiftId && (x.requirementId ?? '') === (placeReq ?? ''))
                    const shift = config.shifts.find((x) => x.id === c.shiftId)!
                    const req = shift.requirements.find((r) => r.id === placeReq)
                    const cap = req ? reqCount(config, shift, req, date) : config.students.maxPerShift
                    const problems = arrange.issues.get(key)
                    const target = arrange.moves.has(key)
                    return (
                      <td
                        key={c.key}
                        className={`extra-col arrange ${target ? 'target' : ''} ${problems ? 'issue' : ''} ${arrange.changed.has(key) ? 'changed' : ''}`}
                        title={problems?.join('\n')}
                        onClick={() => arrange.picked && arrange.onPlace(date, c.shiftId, placeReq)}
                      >
                        {here.map((x) => {
                          const picked = arrange.picked === x
                          const swap = arrange.swaps.has(`${key}|${x.memberId}`)
                          return (
                            <button
                              key={x.memberId}
                              type="button"
                              className={`who-chip small-chip chip-btn ${picked ? 'picked' : ''} ${swap ? 'swap-ok' : ''} ${avoided(x.memberId, date) ? `avoided avoided-${avoided(x.memberId, date)}` : ''}`}
                              aria-pressed={picked}
                              onClick={(e) => {
                                e.stopPropagation()
                                arrange.onChip(x)
                              }}
                            >
                              {nameOf(x.memberId)}
                              {avoidMark(x.memberId, date)}
                            </button>
                          )
                        })}
                        {here.length < cap && <span className={`slot ${target ? 'slot-ok' : ''}`}>{target ? t("move here") : '—'}</span>}
                        {problems && <span className="issue-text">{problems[0]}</span>}
                      </td>
                    );
                  }
                  if (c.kind === 'presenters') {
                    // Each presentation that day; in the combined one-day column, labelled with its name.
                    return (
                      <td key={c.key} className="extra-col">
                        {presenterParts(config, roster, c, date)!.map(({ rule, ids: who }) => (
                          <div key={rule.id} className="present-part">
                            {c.ruleIds.length > 1 && <span className="present-label">{rule.name}</span>}
                            {who.length === 0 && <span className="muted tiny">—</span>}
                            {who.map((id) => (
                              <span key={id} className={`who-chip small-chip ${id === myId ? 'mine' : ''}`}>
                                {nameOf(id)}
                                {roster.presenters.find((p) => p.date === date && p.ruleId === rule.id && p.memberId === id)?.postCall && (
                                  <span title={t("Was on last night’s shift")}> ●</span>
                                )}
                              </span>
                            ))}
                          </div>
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
                          <span
                            key={k}
                            className={`who-chip small-chip ${id === myId ? 'mine' : ''} ${studentCol && avoided(id, date) ? `avoided avoided-${avoided(id, date)}` : ''}`}
                          >
                            {nameOf(id)}
                            {studentCol && avoidMark(id, date)}
                          </span>
                        ))}
                      </td>
                    );
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
                      coversJob(m, req.jobId, date),
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
                            {a ? nameOf(a.memberId) : t("unfilled")}
                            {a && swapOpen.some((s) => s.memberId === a.memberId && s.date === date && s.shiftId === c.shiftId) && (
                              <span title={t("Swap requested")}> ⇄</span>
                            )}
                          </span>
                        );
                      })}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

