import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dayDiff } from './dates.ts'
import { solve, validate } from './solver.ts'
import { importAiResult } from './ai.ts'
import { DEFAULT_RESPONSE, type MemberResponse, type SessionConfig } from './types.ts'

function config(residents: number, staff = 0): SessionConfig {
  return {
    title: 'Test',
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
    extraConditions: '',
  }
}

const resp = (o: Partial<MemberResponse>): MemberResponse => ({ ...DEFAULT_RESPONSE, ...o })

test('fills every seat fairly and passes validation', () => {
  const c = config(6, 3)
  const r = solve(c, {})
  assert.ok(r.ok)
  assert.equal(r.assignments.length, 60)
  assert.deepEqual(validate(c, {}, r.assignments), [])
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
  if (imported.ok) assert.deepEqual(validate(c, {}, imported.assignments), [])
})
