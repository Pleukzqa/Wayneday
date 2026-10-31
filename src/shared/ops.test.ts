import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actOnSwap, addNote, createJoin, decideJoin, readNote, removeNote, requestSwap, saveResponse, visibleNotes } from './ops.ts'
import { DEFAULT_RESPONSE, DEFAULT_STUDENTS, type PublicSession } from './types.ts'

function session(): PublicSession {
  return {
    code: 'a-b-c',
    createdAt: 0,
    version: 0,
    config: {
      title: 'T',
      rosterMode: 'generate',
      duty: [],
      presentationOverrides: [],
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
    notes: [],
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

test('students can swap their places too', () => {
  const s = session()
  s.config.members.push({ id: 'stu1', name: 'stu1', type: 'student', jobs: [] }, { id: 'stu2', name: 'stu2', type: 'student', jobs: [] })
  s.schedule!.students = [
    { date: '2026-11-01', shiftId: 'n', memberId: 'stu1' },
    { date: '2026-11-03', shiftId: 'n', memberId: 'stu2' },
  ]
  const req = requestSwap(s, as('stu1'), { date: '2026-11-01', shiftId: 'n', requirementId: 'student', note: '' })
  actOnSwap(s, as('stu2'), req.id, { action: 'offer', give: { date: '2026-11-03', shiftId: 'n', requirementId: 'student' } })
  actOnSwap(s, as('stu1'), req.id, { action: 'accept', offerId: s.swaps[0].offers[0].id })
  actOnSwap(s, host, req.id, { action: 'approve' })
  assert.deepEqual(
    s.schedule!.students.map((x) => [x.date, x.memberId]),
    [
      ['2026-11-01', 'stu2'],
      ['2026-11-03', 'stu1'],
    ],
  )
})

test('host notes: only hosts write them, only that member (and hosts) see them, only they mark them read', () => {
  const s = session()
  const by = { by: 'Dr. Host', role: 'owner' as const }
  assert.throws(() => addNote(s, as('ann'), 'ben', 'hi', by), /Only hosts/)
  assert.throws(() => addNote(s, host, 'nobody', 'hi', by), /No such member/)
  assert.throws(() => addNote(s, host, 'ann', '   ', by), /Write something/)
  addNote(s, host, 'ann', 'Please add your exam dates', by)
  addNote(s, host, 'ben', 'Thanks!', by)
  assert.deepEqual(visibleNotes(s, as('ann')).map((n) => n.text), ['Please add your exam dates'])
  assert.deepEqual(visibleNotes(s, { isHost: false, memberId: null }), [])
  assert.equal(visibleNotes(s, host).length, 2)
  const id = s.notes[0].id
  assert.throws(() => readNote(s, as('ben'), id), /someone else/)
  readNote(s, as('ann'), id)
  assert.ok(s.notes[0].readAt)
  assert.throws(() => removeNote(s, as('ann'), id), /Only hosts/)
  removeNote(s, host, id)
  assert.equal(s.notes.length, 1)
})

test('a host changing someone’s answers with a reason sends them one message, kept up to date', () => {
  const s = session()
  const edit = { reason: 'Too many asked for the 14th off', by: 'Dr. Host', role: 'owner' as const }
  saveResponse(s, as('ann'), 'ann', { ...DEFAULT_RESPONSE, unavailable: ['2026-11-14'] })
  saveResponse(s, host, 'ann', { ...DEFAULT_RESPONSE, unavailable: [] }, edit)
  assert.equal(s.changes.at(-1)!.reason, edit.reason)
  assert.equal(s.notes.length, 1)
  const note = s.notes[0]
  assert.equal(note.memberId, 'ann')
  assert.equal(note.text, edit.reason)
  assert.equal(note.change?.id, s.changes.at(-1)!.id)
  assert.match(note.change!.summary, /cleared 1 unavailable/)
  readNote(s, as('ann'), note.id)
  // More edits a moment later: the same message, updated and shown again.
  saveResponse(s, host, 'ann', { ...DEFAULT_RESPONSE, unavailable: [], minInterval: 3 }, { ...edit, reason: 'Also needed a shorter gap' })
  assert.equal(s.notes.length, 1)
  assert.equal(s.notes[0].text, 'Also needed a shorter gap')
  assert.equal(s.notes[0].readAt, undefined)
  assert.match(s.notes[0].change!.summary, /interval 2→3/)
  // Someone who never answered: compared with the defaults.
  saveResponse(s, host, 'cat', { ...DEFAULT_RESPONSE, minInterval: 4 }, edit)
  assert.match(s.notes.at(-1)!.change!.summary, /interval 2→4/)
  // Without a reason (e.g. undoing), no message.
  saveResponse(s, host, 'ben', { ...DEFAULT_RESPONSE, minInterval: 4 })
  assert.equal(s.notes.length, 2)
})
