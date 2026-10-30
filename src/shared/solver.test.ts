import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dayDiff } from './dates.ts'
import { countArrangements, solve, solveMany, validate } from './solver.ts'
import { arrangeStudents, countStudentArrangements, pickPresenters, studentExposure, studentOptions } from './students.ts'
import { importAiResult } from './ai.ts'
import { DEFAULT_RESPONSE, DEFAULT_STUDENTS, type MemberResponse, type SessionConfig } from './types.ts'

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

test('counts student arrangements exactly when small', () => {
  const c = hospital()
  c.endDate = '2026-11-04'
  c.members = c.members.filter((m) => m.id !== 'stB' && m.id !== 'stC')
  c.students = { ...c.students, shiftsPerStudent: 2 }
  // One student, 2 nights out of 4, at least 2 days apart: {1,3},{1,4},{2,4} = 3
  assert.deepEqual(countStudentArrangements(c, {}), { exact: true, count: 3 })
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
