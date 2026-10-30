import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actOnSwap, createJoin, decideJoin, requestSwap, saveResponse } from './ops.ts'
import { DEFAULT_RESPONSE, DEFAULT_STUDENTS, type PublicSession } from './types.ts'

function session(): PublicSession {
  return {
    code: 'a-b-c',
    createdAt: 0,
    version: 0,
    config: {
      title: 'T',
      startDate: '2026-11-01',
      endDate: '2026-11-03',
      holidays: [],
      jobs: [{ id: 'w', name: 'Ward' }],
      shifts: [{ id: 'n', name: 'Night', start: '16:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6], requirements: [{ id: 'r', jobId: 'w', memberType: 'resident', count: 1 }] }],
      overrides: [],
      members: ['ann', 'ben', 'cat'].map((id) => ({ id, name: id, type: 'resident' as const, jobs: [] })),
      students: DEFAULT_STUDENTS,
      presentations: [],
      extraConditions: '',
    },
    claimed: [],
    responses: {},
    schedule: {
      status: 'review',
      assignments: [
        { date: '2026-11-01', shiftId: 'n', requirementId: 'r', memberId: 'ann' },
        { date: '2026-11-02', shiftId: 'n', requirementId: 'r', memberId: 'ben' },
        { date: '2026-11-03', shiftId: 'n', requirementId: 'r', memberId: 'cat' },
      ],
      students: [],
      presenters: [],
      generatedAt: 0,
      reviewUntil: Date.now() + 1e6,
      source: 'solver',
    },
    concerns: [],
    swaps: [],
    joinRequests: [],
    changes: [],
  }
}

const host = { isHost: true, memberId: null }
const as = (id: string) => ({ isHost: false, memberId: id })

test('a trade goes request → offer → accept → host approval', () => {
  const s = session()
  const req = requestSwap(s, as('ann'), { date: '2026-11-01', shiftId: 'n', requirementId: 'r', note: 'wedding' })
  assert.throws(() => actOnSwap(s, as('ann'), req.id, { action: 'offer' }), /own shift/)
  actOnSwap(s, as('cat'), req.id, { action: 'offer', give: { date: '2026-11-03', shiftId: 'n', requirementId: 'r' } })
  assert.throws(() => actOnSwap(s, host, req.id, { action: 'approve' }), /agree first/)
  actOnSwap(s, as('ann'), req.id, { action: 'accept', offerId: s.swaps[0].offers[0].id })
  assert.throws(() => actOnSwap(s, as('ann'), req.id, { action: 'approve' }), /host/)
  actOnSwap(s, host, req.id, { action: 'approve' })
  const who = Object.fromEntries(s.schedule!.assignments.map((a) => [a.date, a.memberId]))
  assert.deepEqual(who, { '2026-11-01': 'cat', '2026-11-02': 'ben', '2026-11-03': 'ann' })
  assert.equal(s.swaps[0].status, 'approved')
})

test('you can only ask to swap your own shift', () => {
  const s = session()
  assert.throws(() => requestSwap(s, as('ben'), { date: '2026-11-01', shiftId: 'n', requirementId: 'r', note: '' }), /isn’t yours/)
})

test('host edits to someone’s answers are logged with what they had before', () => {
  const s = session()
  saveResponse(s, as('ann'), 'ann', { ...DEFAULT_RESPONSE, unavailable: ['2026-11-02'] })
  assert.equal(s.changes.length, 0)
  saveResponse(s, host, 'ann', { ...DEFAULT_RESPONSE, unavailable: [] })
  assert.equal(s.changes.length, 1)
  assert.deepEqual(s.changes[0].before?.unavailable, ['2026-11-02'])
  assert.match(s.changes[0].summary, /cleared 1/)
  assert.ok(s.responses.ann.editedByHost)
  assert.throws(() => saveResponse(s, as('ben'), 'ann', DEFAULT_RESPONSE), /your own/)
})

test('join requests become new people or link to existing ones', () => {
  const s = session()
  const a = createJoin(s, 'Dan', 'student')
  const id = decideJoin(s, host, a.id, true)!
  assert.ok(s.config.members.some((m) => m.id === id && m.name === 'Dan' && m.type === 'student'))
  const b = createJoin(s, 'Benjamin', 'resident')
  assert.equal(decideJoin(s, host, b.id, true, 'ben'), 'ben')
  assert.equal(s.config.members.length, 4)
  assert.throws(() => decideJoin(s, as('ann'), createJoin(s, 'X', 'staff').id, true), /host/)
})
