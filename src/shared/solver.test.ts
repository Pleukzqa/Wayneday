import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addDays, dateRange, dayDiff } from './dates.ts'
import { shiftHours, shiftPoints, shiftTimes } from './calendar.ts'
import { countArrangements, solve, solveMany, validate } from './solver.ts'
import { arrangeStudents, countStudentArrangements, equalShare, shareGroups, shiftsNeeded, pickPresenters, placeKey, studentCellIssues, studentExposure, studentOptions, studentRuleReport, studentSummaryTable, studentTargets } from './students.ts'
import { buildAiPrompt, importAiResult } from './ai.ts'
import { explainNoArrangement } from './explain.ts'
import { ANY_SHIFT, DEFAULT_RESPONSE, DEFAULT_STUDENTS, dutyOf, type MemberResponse, type SessionConfig, type StudentAssignment } from './types.ts'

function config(residents: number, staff = 0): SessionConfig {
  return {
    title: 'Test',
    rosterMode: 'generate',
    duty: [],
    presentationOverrides: [],
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    holidays: [],
    jobs: [{ id: 'er', name: 'ER' }],
    shifts: [
      {
        id: 'night',
        name: 'Night',
        start: '16:00',
        end: '08:00',
        days: [0, 1, 2, 3, 4, 5, 6],
        requirements: [
          { id: 'r1', jobId: 'er', memberType: 'resident', count: 1 },
          ...(staff ? [{ id: 'r2', jobId: 'er', memberType: 'staff' as const, count: 1 }] : []),
        ],
      },
    ],
    members: [
      ...Array.from({ length: residents }, (_, i) => ({ id: `r${i}`, name: `Res ${i}`, type: 'resident' as const, jobs: [] })),
      ...Array.from({ length: staff }, (_, i) => ({ id: `s${i}`, name: `Staff ${i}`, type: 'staff' as const, jobs: [] })),
    ],
    overrides: [],
    students: DEFAULT_STUDENTS,
    presentations: [],
    extraConditions: '',
  }
}

const resp = (o: Partial<MemberResponse>): MemberResponse => ({ ...DEFAULT_RESPONSE, ...o })

test('fills every seat fairly and passes validation', () => {
  const c = config(6, 3)
  const r = solve(c, {})
  assert.ok(r.ok)
  assert.equal(r.assignments.length, 60)
  assert.deepEqual(validate(c, {}, r), [])
  const res = r.stats.filter((s) => s.memberId.startsWith('r')).map((s) => s.total)
  assert.ok(Math.max(...res) - Math.min(...res) <= 1, `resident totals ${res}`)
})

test('respects unavailability, locks and min interval', () => {
  const c = config(5)
  const responses = {
    r0: resp({ unavailable: ['2026-11-01', '2026-11-02', '2026-11-03'], minInterval: 3 }),
    r1: resp({ locks: [{ date: '2026-11-10', shiftId: 'night' }] }),
  }
  const r = solve(c, responses)
  assert.ok(r.ok)
  const r0 = r.assignments.filter((a) => a.memberId === 'r0').map((a) => a.date).sort()
  assert.ok(!r0.some((d) => d <= '2026-11-03'))
  for (let i = 1; i < r0.length; i++) assert.ok(dayDiff(r0[i - 1], r0[i]) >= 3)
  assert.ok(r.assignments.some((a) => a.memberId === 'r1' && a.date === '2026-11-10'))
})

test('distributed members are spread, dense members are clustered', () => {
  const c = config(4)
  const responses = {
    r0: resp({ preference: 'distributed', minInterval: 2 }),
    r1: resp({ preference: 'dense', minInterval: 2 }),
  }
  const r = solve(c, responses, { iterations: 40_000 })
  assert.ok(r.ok)
  const s0 = r.stats.find((s) => s.memberId === 'r0')!
  const s1 = r.stats.find((s) => s.memberId === 'r1')!
  assert.ok(s0.minGap! > s1.minGap! || s0.avgGap! > s1.avgGap!, JSON.stringify({ s0, s1 }))
})

test('explains impossible rosters', () => {
  // 2 residents, nightly shift, min interval 3: at most ~20 shifts for 30 nights.
  const c = config(2)
  const responses = { r0: resp({ minInterval: 3 }), r1: resp({ minInterval: 3 }) }
  const r = solve(c, responses)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.problems.join('\n'), /at most/)
})

test('detects lock conflicts', () => {
  const c = config(4)
  const responses = {
    r0: resp({ unavailable: ['2026-11-05'], locks: [{ date: '2026-11-05', shiftId: 'night' }] }),
  }
  const r = solve(c, responses)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.problems.join('\n'), /locked and unavailable/)
})

test('imports AI JSON by names', () => {
  const c = config(3)
  const r = solve(c, {})
  assert.ok(r.ok)
  const json = JSON.stringify({
    assignments: r.assignments.map((a) => ({
      date: a.date,
      shift: 'Night',
      job: 'ER',
      member: c.members.find((m) => m.id === a.memberId)!.name,
    })),
  })
  const imported = importAiResult('Here you go:\n```json\n' + json + '\n```', c)
  assert.ok(imported.ok)
  if (imported.ok) assert.deepEqual(validate(c, {}, imported.roster), [])
})

test('date overrides switch shifts off and change counts', () => {
  const c = config(5)
  c.overrides = [
    { date: '2026-11-03', shiftId: 'night', active: false },
    { date: '2026-11-04', shiftId: 'night', active: true, counts: { r1: 2 } },
  ]
  const r = solve(c, {})
  assert.ok(r.ok)
  assert.equal(r.assignments.filter((a) => a.date === '2026-11-03').length, 0)
  assert.equal(r.assignments.filter((a) => a.date === '2026-11-04').length, 2)
  assert.equal(r.assignments.length, 30)
})

test('students are spread evenly across residents and staff', () => {
  const c = config(4, 2)
  c.members.push(...['A', 'B', 'C'].map((n) => ({ id: `st${n}`, name: `Student ${n}`, type: 'student' as const, jobs: [] })))
  c.students = { shiftIds: ['night'], maxPerShift: 1, shiftsPerStudent: 6 }
  const r = solve(c, {})
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems))
  assert.equal(r.students.length, 18)
  assert.ok(!r.assignments.some((a) => a.memberId.startsWith('st')), 'students never fill positions')
  const exp = studentExposure(c, r.assignments, r.students)
  const res = ['r0', 'r1', 'r2', 'r3'].map((id) => exp[id])
  const staff = ['s0', 's1'].map((id) => exp[id])
  assert.ok(Math.max(...res) - Math.min(...res) <= 1, `resident exposure ${res}`)
  assert.ok(Math.max(...staff) - Math.min(...staff) <= 1, `staff exposure ${staff}`)
  assert.deepEqual(validate(c, {}, r), [])
})

test('presenters come from yesterday’s shift first', () => {
  const c = config(6)
  c.presentations = [{ id: 'mr', name: 'Morning report', days: [1, 2, 3, 4, 5], count: 2, fromShiftId: 'night', fromCount: 1, types: ['resident'] }]
  const r = solve(c, {})
  assert.ok(r.ok)
  const weekdays = r.presenters.filter((p) => p.date > '2026-11-01')
  assert.ok(weekdays.length > 0)
  const byDate = new Map<string, typeof weekdays>()
  for (const p of weekdays) byDate.set(p.date, [...(byDate.get(p.date) ?? []), p])
  for (const [, ps] of byDate) {
    assert.equal(ps.length, 2)
    assert.equal(ps.filter((p) => p.postCall).length, 1)
  }
})

test('counts small rosters exactly and estimates large ones', () => {
  const c = config(3)
  c.endDate = '2026-11-03'
  // 3 nights, 3 residents, interval 1 -> 3^3 = 27; interval 2 -> no back-to-back -> 3*2*2 = 12
  const exact = countArrangements(c, Object.fromEntries(['r0', 'r1', 'r2'].map((id) => [id, resp({ minInterval: 2 })])))
  assert.deepEqual(exact, { exact: true, count: 12 })
  const big = countArrangements(config(8), {})
  assert.equal(big.exact, false)
  if (!big.exact) assert.ok(big.log10 > 10, `log10 ${big.log10}`)
})

test('offers several distinct arrangements, best first', () => {
  const r = solveMany(config(5), {}, { count: 4, iterations: 20_000 })
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.alternatives.length, 4)
  for (let i = 1; i < r.alternatives.length; i++) assert.ok(r.alternatives[i - 1].score <= r.alternatives[i].score)
})

// ---------- hospital mode ----------

function hospital(): SessionConfig {
  const c = config(4, 2)
  c.rosterMode = 'hospital'
  c.members.push(...['A', 'B', 'C'].map((n) => ({ id: `st${n}`, name: `Student ${n}`, type: 'student' as const, jobs: [] })))
  c.students = { shiftIds: [], maxPerShift: 1, shiftsPerStudent: 5 }
  // In hospital mode a shift's positions are the student places: here one ER student per night.
  c.shifts[0].requirements = [{ id: 'p1', jobId: 'er', memberType: 'any', count: 1 }]
  // The hospital's roster: a fixed rotation, deliberately with back-to-back nights (not ours to judge).
  for (let i = 0; i < 30; i++) {
    const date = `2026-11-${String(i + 1).padStart(2, '0')}`
    c.duty.push({ date, shiftId: 'night', requirementId: 'resident', memberId: `r${Math.floor(i / 2) % 4}` })
    c.duty.push({ date, shiftId: 'night', requirementId: 'staff', memberId: `s${i % 2}` })
  }
  return c
}

test('hospital mode keeps residents/staff as given and only places students', () => {
  const c = hospital()
  const r = studentOptions(c, {}, c.duty, { count: 3 })
  assert.ok(r.ok)
  if (!r.ok) return
  for (const o of r.alternatives) {
    assert.deepEqual(o.roster.assignments, c.duty)
    assert.equal(o.roster.students.length, 15)
    assert.ok(o.roster.students.every((x) => x.requirementId === 'p1'))
    assert.deepEqual(validate(c, {}, o.roster), [], 'hospital roster isn’t judged against intervals')
  }
  const exp = studentExposure(c, r.alternatives[0].roster.assignments, r.alternatives[0].roster.students)
  const res = ['r0', 'r1', 'r2', 'r3'].map((id) => exp[id])
  assert.ok(Math.max(...res) - Math.min(...res) <= 1, `resident exposure ${res}`)
})

test('hospital roster left blank: students are arranged on their own', () => {
  const c = hospital()
  c.noDuty = true
  c.students = { ...c.students, avoidRepeatResident: true }
  const r = studentOptions(c, {}, dutyOf(c), { count: 2 })
  assert.ok(r.ok)
  if (!r.ok) return
  assert.deepEqual(r.alternatives[0].roster.assignments, [], 'names already typed in are kept but not used')
  assert.equal(r.alternatives[0].roster.students.length, 15)
  const prompt = buildAiPrompt(c, {})
  assert.match(prompt, /Hospital roster\nNot known yet/)
  assert.doesNotMatch(prompt, /Fixed roster from the hospital/)
})

test('no arrangement: it says why and which single change would work', () => {
  // 3 students × 11 nights, but only 30 places.
  const c = hospital()
  c.students = { ...c.students, shiftsPerStudent: 11 }
  assert.equal(studentOptions(c, {}, c.duty, { count: 1 }).ok, false)
  const e = explainNoArrangement(c, {}, c.duty)
  assert.match(e.hints[0].why, /3 students × 11 shifts = 33 shifts, but there are only 30/)
  assert.match(e.hints[0].fix, /10 shifts or fewer/)
  assert.equal(e.freeWorks, false, 'too many shifts each: impossible whatever people answer')
  assert.ok(e.wouldWork.some((w) => /Share equally/.test(w)), e.wouldWork.join(' | '))

  // One student who's away most of the month.
  const d = hospital()
  const away = dateRange('2026-11-01', '2026-11-24')
  const responses = { stA: resp({ unavailable: away }) }
  assert.equal(studentOptions(d, responses, d.duty, { count: 1 }).ok, false)
  const why = explainNoArrangement(d, responses, d.duty)
  const a = why.hints.find((h) => h.why.startsWith('Student A'))
  assert.ok(a, why.hints.map((h) => h.why).join(' | '))
  assert.match(a.why, /fits only \d of 5 shifts around their 24 unavailable day\(s\)/)
  assert.match(a.fix, /Student A/)
  assert.equal(why.freeWorks, true, 'it’s Student A’s days that block it')
})

test('no arrangement with fixed minimums: suggests who could free which day', () => {
  // Every night must have a student; on the 10th all three are away.
  const c = hospital()
  c.shifts[0].requirements = [{ id: 'p1', jobId: 'er', memberType: 'any', count: 1, min: 1 }]
  c.students = { ...c.students, auto: true }
  const away = { unavailable: ['2026-11-10'] }
  const responses = { stA: resp(away), stB: resp(away), stC: resp(away) }
  assert.equal(studentOptions(c, responses, c.duty, { count: 1 }).ok, false)
  const e = explainNoArrangement(c, responses, c.duty)
  assert.ok(e.hints.some((h) => /On .*10\/11, a place needs a student/.test(h.why) && /Student A/.test(h.why)), e.hints.map((h) => h.why).join(' | '))
  assert.ok(!e.hints.some((h) => /minimum/i.test(h.fix)), 'never suggests lowering a minimum')
  assert.ok(e.wouldWork.includes('Student A freeing Tue 10/11'), e.wouldWork.join(' | '))
  assert.equal(e.freeWorks, true)
  assert.ok(!e.wouldWork.some((w) => /minimum/.test(w)))
})

test('student places need no job (place) in hospital mode', () => {
  const c = hospital()
  c.jobs = []
  c.shifts = c.shifts.map((s) => ({ ...s, requirements: s.requirements.map((r) => ({ ...r, jobId: '' })) }))
  const r = studentOptions(c, {}, c.duty, { count: 2 })
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.alternatives[0].roster.students.length, 15)
  assert.deepEqual(validate(c, {}, r.alternatives[0].roster), [])
  assert.match(buildAiPrompt(c, {}), /up to \d+ student\(s\)[,\n]/, 'the AI prompt doesn’t mention a job')
})

test('presenters: one from each ward, whichever shift had it', () => {
  const c = hospital()
  c.jobs = [{ id: 'a', name: '17C' }, { id: 'b', name: '26A' }]
  const places = (p: string) => [{ id: `${p}a`, jobId: 'a', memberType: 'any' as const, count: 1 }, { id: `${p}b`, jobId: 'b', memberType: 'any' as const, count: 1 }]
  // Weeknights and a weekend shift, each with a student in 17C and in 26A.
  c.shifts = [
    { ...c.shifts[0], days: [1, 2, 3, 4, 5], requirements: places('n') },
    { id: 'we', name: 'Weekend', start: '08:00', end: '08:00', days: [0, 6], requirements: places('w') },
  ]
  c.members.push(...['D', 'E', 'F'].map((n) => ({ id: `st${n}`, name: `Student ${n}`, type: 'student' as const, jobs: [] })))
  c.students = { ...c.students, auto: true }
  c.presentations = [{ id: 'mr', name: 'Morning report', days: [1, 2, 3, 4, 5], count: 2, fromShiftId: ANY_SHIFT, fromCount: 1, types: ['student'],
    sources: [{ shiftId: ANY_SHIFT, jobId: 'a', count: 1 }, { shiftId: ANY_SHIFT, jobId: 'b', count: 1 }] }]
  const s = arrangeStudents(c, {}, c.duty)
  assert.ok(s.ok)
  if (!s.ok) return
  const p = pickPresenters(c, {}, c.duty, s.students)
  const days = [...new Set(p.presenters.map((x) => x.date))].filter((d) => d > c.startDate)
  assert.ok(days.length > 15)
  const job = (x: StudentAssignment) => (x.requirementId?.endsWith('a') ? 'a' : 'b')
  for (const date of days) {
    const ids = p.presenters.filter((x) => x.date === date).map((x) => x.memberId)
    const was = (j: string) => s.students.find((x) => x.date === addDays(date, -1) && job(x) === j)?.memberId
    assert.ok(ids.includes(was('a')!) && ids.includes(was('b')!), `${date}: ${ids} should include ${was('a')} (17C) and ${was('b')} (26A)`)
  }
  assert.match(buildAiPrompt(c, {}), /at least 1 who worked any shift in 17C the day before/)
})

test('presenters from 2–3 days before, with one date changed back to last night', () => {
  const c = hospital()
  c.members.push(...['D', 'E', 'F'].map((n) => ({ id: `st${n}`, name: `Student ${n}`, type: 'student' as const, jobs: [] })))
  c.students = { ...c.students, auto: true }
  c.presentations = [{ id: 'mr', name: 'Morning report', days: [1, 2, 3, 4, 5], count: 1, fromShiftId: 'night', fromCount: 1, types: ['student'], daysBack: [2, 3] }]
  c.presentationOverrides = [{ date: '2026-11-18', ruleId: 'mr', active: true, daysBack: [1, 1] }]
  const s = arrangeStudents(c, {}, c.duty)
  assert.ok(s.ok)
  if (!s.ok) return
  const p = pickPresenters(c, {}, c.duty, s.students)
  const on = (date: string, back: number) => s.students.find((x) => x.date === addDays(date, -back))?.memberId
  const days = p.presenters.filter((x) => x.date >= '2026-11-04')
  assert.ok(days.length > 15)
  for (const x of days) {
    if (x.date === '2026-11-18') {
      assert.equal(x.memberId, on(x.date, 1), 'that date takes last night’s student')
      assert.ok(x.postCall)
    } else {
      assert.ok([on(x.date, 2), on(x.date, 3)].includes(x.memberId), `${x.date}: ${x.memberId} wasn’t on 2–3 days before`)
      assert.equal(x.postCall, x.memberId === on(x.date, 1))
    }
  }
  assert.match(buildAiPrompt(c, {}), /who worked "Night" 2–3 days before/)
  assert.match(buildAiPrompt(c, {}), /2026-11-18: 1 presenter\(s\), including at least 1 who worked "Night" the day before/)
})

test('sharing equally within rotations of different sizes', () => {
  // Two wards, one student each every night. Rotation 1 (3 students): Ward A then Ward B; rotation 2 (2 students): the other way.
  const c = hospital()
  c.jobs = [{ id: 'a', name: 'Ward A' }, { id: 'b', name: 'Ward B' }]
  c.shifts = [{ ...c.shifts[0], requirements: [{ id: 'wa', jobId: 'a', memberType: 'any', count: 1, min: 1 }, { id: 'wb', jobId: 'b', memberType: 'any', count: 1, min: 1 }] }]
  c.members = c.members.filter((m) => m.type !== 'student')
  const plan = (first: string, then: string) => [{ jobId: first, from: '2026-11-01', to: '2026-11-15' }, { jobId: then, from: '2026-11-16', to: '2026-11-30' }]
  for (const n of ['A', 'B', 'C']) c.members.push({ id: `st${n}`, name: `Student ${n}`, type: 'student', jobs: [], periods: plan('a', 'b') })
  for (const n of ['D', 'E']) c.members.push({ id: `st${n}`, name: `Student ${n}`, type: 'student', jobs: [], periods: plan('b', 'a') })
  c.students = { ...c.students, auto: true }
  assert.deepEqual(shareGroups(c).map((g) => [g.members.length, g.places]), [[3, 30], [2, 30]])
  // Shared across all five it would be 12 each, which neither ward can take; within each rotation it's 10 and 15.
  const r = studentOptions(c, {}, c.duty, { count: 2 })
  assert.ok(r.ok, r.ok ? '' : r.problems.join(' | '))
  if (!r.ok) return
  const counts = (ids: string[]) => ids.map((id) => r.alternatives[0].roster.students.filter((x) => x.memberId === id).length)
  assert.deepEqual(counts(['stA', 'stB', 'stC']), [10, 10, 10])
  assert.deepEqual(counts(['stD', 'stE']), [15, 15])
  assert.deepEqual([...studentCellIssues(c, {}, r.alternatives[0].roster.students).values()].flat(), [], 'equal within each rotation is not flagged')
  assert.equal(shiftsNeeded(c), 15)
})

test('a presenter source can count another shift the same, e.g. the weekend night before a Monday', () => {
  const c = hospital()
  c.jobs = [{ id: 'w', name: '19C' }]
  c.shifts = [
    { ...c.shifts[0], id: 'wk', name: 'Night', days: [1, 2, 3, 4, 5], requirements: [{ id: 'wk19', jobId: 'w', memberType: 'any', count: 1 }] },
    { ...c.shifts[0], id: 'we', name: 'Night (weekend)', start: '08:00', end: '08:00', days: [0, 6], requirements: [{ id: 'we19', jobId: 'w', memberType: 'any', count: 1 }] },
  ]
  c.duty = []
  c.noDuty = true
  c.students = { ...c.students, auto: true }
  const rule = { id: 'mr', name: 'Morning report', days: [1, 2, 3, 4], count: 1, fromShiftId: 'wk', fromCount: 1, types: ['student' as const] }
  c.presentations = [{ ...rule, sources: [{ shiftId: 'wk', placeId: 'wk19', count: 1 }] }]
  const s = arrangeStudents(c, {}, [])
  assert.ok(s.ok)
  if (!s.ok) return
  // Only the weekday night: Mondays have nobody from "last night".
  assert.match(pickPresenters(c, {}, [], s.students).warnings.join(' '), /not enough/)
  // Counting the weekend night the same: every Monday takes Sunday night's 19C student.
  c.presentations = [{ ...rule, sources: [{ shiftId: 'wk', placeId: 'wk19', count: 1, orShiftIds: ['we'] }] }]
  const p = pickPresenters(c, {}, [], s.students)
  assert.deepEqual(p.warnings, [])
  for (const monday of ['2026-11-09', '2026-11-16', '2026-11-23']) {
    const sunday: StudentAssignment = s.students.find((x) => x.date === addDays(monday, -1))!
    assert.equal(sunday.shiftId, 'we')
    assert.equal(p.presenters.find((x) => x.date === monday)?.memberId, sunday.memberId)
  }
  assert.match(buildAiPrompt(c, {}), /who worked "Night" or "Night \(weekend\)" \(19C\) the day before/)
})

test('presentations are shared out evenly, in all and by type', () => {
  const c = hospital()
  c.members.push(...['D', 'E'].map((n) => ({ id: `st${n}`, name: `Student ${n}`, type: 'student' as const, jobs: [] })))
  c.students = { ...c.students, auto: true }
  const base = { fromShiftId: 'night', fromCount: 1, types: ['student' as const] }
  c.presentations = [
    { ...base, id: 'mr', name: 'Morning report', days: [1, 2, 3, 4, 5], count: 1 },
    ...['2026-11-06', '2026-11-12', '2026-11-18', '2026-11-24', '2026-11-27'].map((d, i) => ({ ...base, id: `cc${i}`, name: `CCR ${i}`, days: [], dates: [d], count: 1 })),
  ]
  const studs = ['stA', 'stB', 'stC', 'stD', 'stE']
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
  for (let seed = 1; seed <= 4; seed++) {
    const s = arrangeStudents(c, {}, c.duty, seed)
    assert.ok(s.ok)
    if (!s.ok) return
    const p = pickPresenters(c, {}, c.duty, s.students, seed).presenters
    const count = (f: (x: (typeof p)[number]) => boolean) => studs.map((id) => p.filter((x) => x.memberId === id && f(x)).length)
    assert.ok(spread(count(() => true)) <= 1, `seed ${seed}: total ${count(() => true)}`)
    assert.ok(spread(count((x) => x.ruleId === 'mr')) <= 1, `seed ${seed}: morning ${count((x) => x.ruleId === 'mr')}`)
    assert.ok(spread(count((x) => x.ruleId.startsWith('cc'))) <= 1, `seed ${seed}: one-day ${count((x) => x.ruleId.startsWith('cc'))}`)
  }
  const table = studentSummaryTable(c, { assignments: c.duty, students: [], presenters: [] })
  assert.deepEqual(table.header.slice(0, table.lead), ['Student', 'Shifts', 'Presentations', 'Morning report', 'One-day presentations'])
})

test('someone away on a presentation day isn’t put on the night it takes presenters from', () => {
  // One student a night; a case discussion on the 17th needs last night's student, and Student A is ✕ that day.
  const c = hospital()
  c.students = { ...c.students, auto: true }
  c.presentations = [{ id: 'ccr', name: 'CCR', days: [], dates: ['2026-11-17'], count: 1, fromShiftId: 'night', fromCount: 1, types: ['student'] }]
  const responses = { stA: resp({ unavailable: ['2026-11-17'] }) }
  for (let seed = 1; seed <= 6; seed++) {
    const s = arrangeStudents(c, responses, c.duty, seed)
    assert.ok(s.ok)
    if (!s.ok) return
    assert.notEqual(s.students.find((x) => x.date === '2026-11-16')?.memberId, 'stA', `seed ${seed}`)
    assert.deepEqual(pickPresenters(c, responses, c.duty, s.students).warnings, [])
  }
})

test('dated places: a student covers Ward A until the 15th, then Ward B', () => {
  const c = hospital()
  c.jobs = [{ id: 'a', name: 'Ward A' }, { id: 'b', name: 'Ward B' }]
  c.shifts = [{ ...c.shifts[0], requirements: [{ id: 'wa', jobId: 'a', memberType: 'any', count: 1 }, { id: 'wb', jobId: 'b', memberType: 'any', count: 1 }] }]
  c.members.push({ id: 'stD', name: 'Student D', type: 'student', jobs: [] })
  const stA = c.members.find((m) => m.id === 'stA')!
  stA.jobs = ['b']
  stA.periods = [{ jobId: 'a', from: '2026-11-01', to: '2026-11-15' }, { jobId: 'b', from: '2026-11-16', to: '2026-11-30' }]
  // Student B: only Ward A for the first week, any place afterwards.
  c.members.find((m) => m.id === 'stB')!.periods = [{ jobId: 'a', from: '2026-11-01', to: '2026-11-07' }]
  const where = (date: string) => (date <= '2026-11-15' ? 'wa' : 'wb')
  for (let seed = 1; seed <= 5; seed++) {
    const s = arrangeStudents(c, {}, c.duty, seed)
    assert.ok(s.ok)
    if (!s.ok) return
    const a = s.students.filter((x) => x.memberId === 'stA')
    assert.ok(a.length > 0)
    for (const x of a) assert.equal(x.requirementId, where(x.date), `${x.date}: Student A should be in ${where(x.date)}`)
    for (const x of s.students.filter((y) => y.memberId === 'stB' && y.date <= '2026-11-07')) assert.equal(x.requirementId, 'wa')
    assert.deepEqual([...studentCellIssues(c, {}, s.students).values()].flat(), [])
  }
  const wrong = [{ date: '2026-11-03', shiftId: 'night', requirementId: 'wb', memberId: 'stA' }]
  assert.match([...studentCellIssues(c, {}, wrong).values()].flat().join(' '), /Student A is in Ward A on this date/)
  assert.match(buildAiPrompt(c, {}), /only in Ward A from 2026-11-01 to 2026-11-15/)
})

/** Like a real rotation: a night shift taking 2 students and a 24-hour shift taking 1, shared equally by 7. */
function equalRotation(): SessionConfig {
  const c = hospital()
  c.jobs = []
  c.shifts = [
    { ...c.shifts[0], requirements: [{ id: 'n', jobId: '', memberType: 'any', count: 2 }] },
    { id: 'day', name: '24h', start: '08:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6], requirements: [{ id: 'd', jobId: '', memberType: 'any', count: 1 }] },
  ]
  c.members.push(...['D', 'E', 'F', 'G'].map((n) => ({ id: `st${n}`, name: `Student ${n}`, type: 'student' as const, jobs: [] })))
  c.students = { ...c.students, auto: true }
  return c
}

test('sharing equally fills every place and splits them within one shift', () => {
  const c = equalRotation()
  // 30 nights × 2 + 30 days × 1 = 90 places for 7 students: 6 do 13, 1 does 12.
  assert.deepEqual(equalShare(c), { total: 90, base: 12, extra: 6 })
  const responses = { stA: { ...DEFAULT_RESPONSE, unavailable: ['2026-11-03', '2026-11-04', '2026-11-05'] } }
  const r = studentOptions(c, responses, c.duty, { count: 3 })
  assert.ok(r.ok, r.ok ? '' : r.problems.join('; '))
  if (!r.ok) return
  for (const o of r.alternatives) {
    const per = (id: string, shiftId?: string) => o.roster.students.filter((x) => x.memberId === id && (!shiftId || x.shiftId === shiftId)).length
    const ids = c.members.filter((m) => m.type === 'student').map((m) => m.id)
    assert.equal(o.roster.students.length, 90)
    assert.deepEqual(ids.map((id) => per(id)).sort(), [12, 13, 13, 13, 13, 13, 13])
    const nights = ids.map((id) => per(id, 'night'))
    assert.ok(Math.max(...nights) - Math.min(...nights) <= 2, `similar mix of shift slots: ${nights}`)
    assert.ok(!o.roster.students.some((x) => x.memberId === 'stA' && responses.stA.unavailable.includes(x.date)))
    assert.equal(studentCellIssues(c, responses, o.roster.students).size, 0)
  }
})

test('sharing equally stays equal when someone can only do a few shifts', () => {
  const c = equalRotation()
  // Student A is away for most of the month: 3 shifts at most, so everyone else does 3 or 4.
  const away = dateRange('2026-11-06', '2026-11-30')
  const r = arrangeStudents(c, { stA: { ...DEFAULT_RESPONSE, unavailable: away } }, c.duty)
  assert.ok(r.ok, r.ok ? '' : r.problems.join('; '))
  if (!r.ok) return
  const counts = c.members.filter((m) => m.type === 'student').map((m) => r.students.filter((x) => x.memberId === m.id).length)
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${counts}`)
  assert.match(r.warnings.join(' '), /Student A can only fit 3 shifts/)
})

/** Like a medicine rotation sheet: 2 students on call every night, weekday 1 point, weekend 2, special exam days. */
function pointsRotation(on: boolean): SessionConfig {
  const days = dateRange('2025-10-27', '2025-12-04')
  return {
    ...hospital(),
    startDate: days[0],
    endDate: days[days.length - 1],
    holidays: [],
    jobs: [],
    duty: [],
    shifts: [{ id: 'oc', name: 'On call', start: '16:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6], requirements: [{ id: 'p', jobId: '', memberType: 'any', count: 2 }] }],
    // Exam on Thursday 4 Dec: 2 days before = 1.5, the night before = everyone off, exam day = 1.
    overrides: [{ date: '2025-12-03', shiftId: 'oc', active: false }],
    datePoints: { '2025-12-02': 1.5, '2025-12-03': 3, '2025-12-04': 1 },
    members: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, type: 'student' as const, jobs: [] })),
    students: { shiftIds: [], maxPerShift: 1, shiftsPerStudent: 0, auto: true, minGap: 2, points: { on, weekday: 1, weekend: 2 } },
  }
}

test('points: weekday, weekend/holiday, a date’s own points and a slot multiplier', () => {
  const c = pointsRotation(true)
  assert.equal(shiftPoints(c, 'oc', '2025-10-28'), 1) // Tuesday
  assert.equal(shiftPoints(c, 'oc', '2025-11-01'), 2) // Saturday
  assert.equal(shiftPoints(c, 'oc', '2025-12-02'), 1.5)
  c.holidays = ['2025-10-29']
  assert.equal(shiftPoints(c, 'oc', '2025-10-29'), 2)
  c.students.points = { on: true, weekday: 1, weekend: 2, shifts: { oc: 1.5 } }
  assert.equal(shiftPoints(c, 'oc', '2025-11-01'), 3)
  assert.equal(shiftPoints(pointsRotation(false), 'oc', '2025-11-01'), 1, 'points off: every shift counts 1')
})

test('points set by hand for one shift leave the others alone', () => {
  const c = pointsRotation(true)
  c.shifts = [c.shifts[0], { ...c.shifts[0], id: 'day', name: 'Day', start: '08:00', end: '16:00' }]
  c.students.points = { ...c.students.points!, shifts: { oc: 2 } }
  const [a, b] = ['oc', 'day']
  const usual = (id: string, date: string) => shiftPoints(c, id, date)
  const sat = '2025-11-01'
  const mon = '2025-11-03'
  const before = { aSat: usual(a, sat), bSat: usual(b, sat), aMon: usual(a, mon), bMon: usual(b, mon) }
  c.students.points = { ...c.students.points!, fixed: { [`${a}|weekend`]: 7, [`${b}|${mon}`]: 9 } }
  assert.equal(shiftPoints(c, a, sat), 7)
  assert.equal(shiftPoints(c, b, sat), before.bSat, 'the other slot keeps its weekend points')
  assert.equal(shiftPoints(c, a, mon), before.aMon, 'weekday points unchanged')
  assert.equal(shiftPoints(c, b, mon), 9)
  assert.equal(shiftPoints(c, b, '2025-11-04'), before.bMon, 'only that date')
  // A date with its own points for every slot beats the weekend one set by hand.
  c.datePoints = { [sat]: 5 }
  assert.equal(shiftPoints(c, a, sat), 5 * (c.students.points.shifts?.[a] ?? 1))
  assert.match(buildAiPrompt(c, {}), /points set by hand.*on weekends\/holidays = 7/)
})

test('points: shift counts stay equal and points come out about equal', () => {
  const spread = (on: boolean, seed: number) => {
    const c = pointsRotation(on)
    const r = arrangeStudents(c, {}, [], seed)
    assert.ok(r.ok)
    if (!r.ok) return { shifts: 99, points: 99 }
    const scored = pointsRotation(true)
    const per = c.members.map((m) => r.students.filter((s) => s.memberId === m.id))
    const pts = per.map((m) => m.reduce((n, s) => n + shiftPoints(scored, s.shiftId, s.date), 0))
    assert.ok(!r.students.some((s) => s.date === '2025-12-03'), 'everyone is off the night before the exam')
    if (on) assert.match(studentRuleReport(c, {}, { assignments: [], students: r.students }).summary.join(' '), /points each/)
    return { shifts: Math.max(...per.map((m) => m.length)) - Math.min(...per.map((m) => m.length)), points: Math.max(...pts) - Math.min(...pts) }
  }
  const seeds = [1, 2, 3, 4, 5, 6]
  const on = seeds.map((seed) => spread(true, seed))
  const off = seeds.map((seed) => spread(false, seed))
  assert.ok([...on, ...off].every((x) => x.shifts <= 1), 'shift counts stay within one')
  assert.ok(on.every((x) => x.points <= 1.5), `points spread with points on: ${on.map((x) => x.points)}`)
  const mean = (xs: { points: number }[]) => xs.reduce((n, x) => n + x.points, 0) / xs.length
  assert.ok(mean(on) < mean(off), `on ${mean(on)} vs off ${mean(off)}`)
})

test('shift lengths: overnight, 24 hours and longer than a day', () => {
  assert.equal(shiftHours({ start: '16:00', end: '08:00' }), 16)
  assert.equal(shiftHours({ start: '08:00', end: '08:00' }), 24)
  assert.equal(shiftHours({ start: '08:00', end: '20:00', endDays: 1 }), 36)
  assert.equal(shiftHours({ start: '08:00', end: '16:00' }), 8)
  assert.equal(shiftTimes({ start: '08:00', end: '20:00', endDays: 1 }), '08:00–20:00 (+1)')
  assert.equal(shiftTimes({ start: '16:00', end: '08:00' }), '16:00–08:00')
})

test('a student is never on two shifts that overlap in time', () => {
  const c = hospital()
  c.jobs = []
  // A 36-hour shift every day: whoever is on Monday's is still working on Tuesday evening.
  c.shifts = [{ id: 'long', name: 'Long', start: '08:00', end: '20:00', endDays: 1, days: [0, 1, 2, 3, 4, 5, 6], requirements: [{ id: 'p', jobId: '', memberType: 'any', count: 1 }] }]
  c.duty = []
  c.endDate = '2026-11-12'
  c.students = { ...c.students, auto: true }
  const responses = Object.fromEntries(['stA', 'stB', 'stC'].map((id) => [id, { ...DEFAULT_RESPONSE, minInterval: 1 }]))
  const r = arrangeStudents(c, responses, [])
  assert.ok(r.ok, r.ok ? '' : r.problems.join('; '))
  if (!r.ok) return
  for (const id of ['stA', 'stB', 'stC']) {
    const days = r.students.filter((s) => s.memberId === id).map((s) => s.date).sort()
    for (let i = 1; i < days.length; i++) assert.ok(dayDiff(days[i - 1], days[i]) >= 2, `${id} on ${days[i - 1]} and ${days[i]}`)
  }
  // Placed by hand on two days in a row, the table says why that's wrong.
  const issues = studentCellIssues(c, responses, [
    { date: '2026-11-02', shiftId: 'long', requirementId: 'p', memberId: 'stA' },
    { date: '2026-11-03', shiftId: 'long', requirementId: 'p', memberId: 'stA' },
  ])
  assert.match([...issues.values()].flat().join(' '), /overlap/)
})

test('presenters: one from each ward of last night, or from the same day', () => {
  const c = hospital()
  c.jobs = [{ id: 'a', name: 'Ward A' }, { id: 'b', name: 'Ward B' }]
  c.shifts = [{ ...c.shifts[0], requirements: [{ id: 'wa', jobId: 'a', memberType: 'any', count: 1 }, { id: 'wb', jobId: 'b', memberType: 'any', count: 1 }] }]
  c.members.push(...['D', 'E', 'F'].map((n) => ({ id: `st${n}`, name: `Student ${n}`, type: 'student' as const, jobs: [] })))
  c.students = { ...c.students, auto: true }
  const rule = { id: 'mr', name: 'Morning report', days: [1, 2, 3, 4, 5], count: 2, fromShiftId: 'night', fromCount: 1, types: ['student' as const] }
  c.presentations = [{ ...rule, sources: [{ shiftId: 'night', placeId: 'wa', count: 1 }, { shiftId: 'night', placeId: 'wb', count: 1 }] }]
  const s = arrangeStudents(c, {}, c.duty)
  assert.ok(s.ok)
  if (!s.ok) return
  const p = pickPresenters(c, {}, c.duty, s.students)
  const days = [...new Set(p.presenters.map((x) => x.date))].filter((d) => d > c.startDate)
  assert.ok(days.length > 15)
  for (const date of days) {
    const ids = p.presenters.filter((x) => x.date === date).map((x) => x.memberId)
    const was = (place: string) => s.students.find((x) => x.date === addDays(date, -1) && x.requirementId === place)?.memberId
    assert.ok(ids.includes(was('wa')!) && ids.includes(was('wb')!), `${date}: ${ids} should include ${was('wa')} and ${was('wb')}`)
  }
  // A one-day case discussion, prepared by someone off last night's shift.
  c.presentations = [{ ...rule, id: 'case', name: 'Case discussion', days: [], dates: ['2026-11-10'], count: 1, sources: [{ shiftId: 'night', count: 1 }] }]
  const one = pickPresenters(c, {}, c.duty, s.students).presenters
  assert.deepEqual(one.map((x) => x.date), ['2026-11-10'])
  assert.ok(s.students.some((y) => y.date === '2026-11-09' && y.memberId === one[0].memberId) && one[0].postCall)
  // A weekend round drawn from the people on duty that same day.
  c.presentations = [{ ...rule, id: 'round', name: 'Round', days: [0, 6], count: 1, sources: [{ shiftId: 'night', count: 1, when: 'same' }] }]
  const q = pickPresenters(c, {}, c.duty, s.students)
  for (const x of q.presenters) assert.ok(s.students.some((y) => y.date === x.date && y.memberId === x.memberId), `${x.date} ${x.memberId}`)
})

test('counts student arrangements exactly when small', () => {
  const c = hospital()
  c.endDate = '2026-11-04'
  c.members = c.members.filter((m) => m.id !== 'stB' && m.id !== 'stC')
  c.students = { ...c.students, shiftsPerStudent: 2 }
  // One student, 2 nights out of 4, at least 2 days apart: {1,3},{1,4},{2,4} = 3
  assert.deepEqual(countStudentArrangements(c, {}), { exact: true, count: 3 })
})

test('presenters can come off any shift, and with a hospital roster only students present', () => {
  const c = equalRotation()
  // An old rule from before: residents allowed, from one shift. Now from any shift.
  c.presentations = [{ id: 'mr', name: 'Morning report', days: [1, 2, 3, 4, 5], count: 1, fromShiftId: ANY_SHIFT, fromCount: 1, types: ['resident'] }]
  const s = arrangeStudents(c, {}, c.duty)
  assert.ok(s.ok)
  if (!s.ok) return
  const p = pickPresenters(c, {}, c.duty, s.students)
  const students = new Set(c.members.filter((m) => m.type === 'student').map((m) => m.id))
  assert.ok(p.presenters.length > 15)
  assert.ok(p.presenters.every((x) => students.has(x.memberId)), 'only students present')
  // Every place is filled every day, so someone always comes off a shift (of either kind).
  assert.ok(p.presenters.filter((x) => x.date > c.startDate).every((x) => x.postCall))
  assert.ok(p.presenters.some((x) => x.postCall && s.students.some((y) => y.memberId === x.memberId && y.shiftId === 'day')))
})

test('presentation numbers can change on single dates', () => {
  const c = hospital()
  c.presentations = [{ id: 'mr', name: 'Morning report', days: [1, 2, 3, 4, 5], count: 2, fromShiftId: 'night', fromCount: 1, types: ['resident', 'student'] }]
  c.presentationOverrides = [
    { date: '2026-11-03', ruleId: 'mr', active: true, count: 1 },
    { date: '2026-11-04', ruleId: 'mr', active: false },
    { date: '2026-11-07', ruleId: 'mr', active: true }, // a Saturday
  ]
  const s = arrangeStudents(c, {}, c.duty)
  assert.ok(s.ok)
  if (!s.ok) return
  const p = pickPresenters(c, {}, c.duty, s.students).presenters
  const on = (d: string) => p.filter((x) => x.date === d).length
  assert.equal(on('2026-11-02'), 2)
  assert.equal(on('2026-11-03'), 1)
  assert.equal(on('2026-11-04'), 0)
  assert.equal(on('2026-11-07'), 2)
})

test('AI replies in hospital mode only change students', () => {
  const c = hospital()
  const reply = JSON.stringify({
    format: 'wayneday-roster',
    assignments: [{ date: '2026-11-01', shift: 'Night', job: 'ER', member: 'Res 3' }],
    students: [{ date: '2026-11-01', shift: 'Night', job: 'ER', member: 'Student A' }],
  })
  const r = importAiResult(reply, c)
  assert.ok(r.ok)
  if (!r.ok) return
  assert.deepEqual(r.roster.assignments, c.duty)
  assert.equal(r.roster.students.length, 1)
})

test('hand-moving a student: legal targets and marked problems', () => {
  const c = hospital()
  const responses = { stA: resp({ minInterval: 3, unavailable: ['2026-11-20'] }) }
  const r = arrangeStudents(c, responses, c.duty)
  assert.ok(r.ok)
  if (!r.ok) return
  const a = r.students.find((x) => x.memberId === 'stA')!
  const { moves } = studentTargets(c, responses, r.students, a)
  assert.ok(!moves.has(placeKey({ date: '2026-11-20', shiftId: 'night', requirementId: 'p1' })), 'never suggests an unavailable day')
  for (const k of moves) {
    const [date] = k.split('|')
    const moved: StudentAssignment[] = r.students.map((x) => (x === a ? { ...x, date } : x))
    assert.equal(studentCellIssues(c, responses, moved).size, 0, `suggested ${k} should keep every rule`)
  }
  // Force a bad move: onto the unavailable day.
  const bad: StudentAssignment[] = r.students.filter((x) => !(x.date === '2026-11-20' && x !== a)).map((x) => (x === a ? { ...x, date: '2026-11-20' } : x))
  const issues = studentCellIssues(c, responses, bad)
  assert.match(issues.get(placeKey({ date: '2026-11-20', shiftId: 'night', requirementId: 'p1' }))?.join() ?? '', /unavailable/)
})

test('two rooms, one of each per student, every room filled, no repeats, avoid requests', () => {
  const c = hospital()
  // Long room every weekday, short room not on Tuesdays; 1–2 students each.
  c.shifts = [
    { id: 'L', name: 'Long', start: '16:30', end: '24:00', days: [1, 2, 3, 4, 5], requirements: [{ id: 'Lp', jobId: 'er', memberType: 'any', count: 2, min: 1 }] },
    { id: 'S', name: 'Short', start: '16:30', end: '20:00', days: [1, 3, 4, 5], requirements: [{ id: 'Sp', jobId: 'er', memberType: 'any', count: 2, min: 1 }] },
  ]
  c.overrides = [{ date: '2026-11-13', shiftId: 'L', active: false }, { date: '2026-11-13', shiftId: 'S', active: false }]
  c.members = Array.from({ length: 22 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, type: 'student' as const, jobs: [] }))
  const docs = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']
  c.members.push(...docs.map((d) => ({ id: d, name: d, type: 'resident' as const, jobs: [] })), { id: 'T', name: 'T', type: 'staff', jobs: [] })
  c.duty = []
  for (let day = 2; day <= 27; day++) {
    const date = `2026-11-${String(day).padStart(2, '0')}`
    c.duty.push({ date, shiftId: 'L', requirementId: 'resident', memberId: docs[day % 6] }, { date, shiftId: 'S', requirementId: 'resident', memberId: docs[(day + 2) % 6] })
  }
  c.startDate = '2026-11-02'
  c.endDate = '2026-11-27'
  c.students = { shiftIds: [], maxPerShift: 2, shiftsPerStudent: 2, perSlot: { L: 1, S: 1 }, avoidRepeatResident: true, avoidRepeatPartner: true, minGap: 7 }
  const responses = { s0: resp({ avoid: [{ date: '2026-11-03', level: 3 }, { date: '2026-11-04', level: 3 }] }) }
  const r = studentOptions(c, responses, c.duty, { count: 2 })
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems))
  if (!r.ok) return
  const roster = r.alternatives[0].roster
  assert.deepEqual(validate(c, responses, roster), [])
  assert.equal(studentCellIssues(c, responses, roster.students).size, 0)
  for (const m of c.members.filter((x) => x.type === 'student')) {
    assert.equal(roster.students.filter((s) => s.memberId === m.id && s.shiftId === 'L').length, 1)
    assert.equal(roster.students.filter((s) => s.memberId === m.id && s.shiftId === 'S').length, 1)
  }
  const report = studentRuleReport(c, responses, roster)
  assert.equal(report.repeats, 0, report.details.join('\n'))
  assert.equal(report.avoidHits[3], 0)
  // Every open room-day has 1–2 students.
  const rooms = new Map<string, number>()
  for (const s of roster.students) rooms.set(`${s.date}|${s.shiftId}`, (rooms.get(`${s.date}|${s.shiftId}`) ?? 0) + 1)
  assert.equal(rooms.size, 19 + 15)
  assert.ok([...rooms.values()].every((n) => n >= 1 && n <= 2))
})
