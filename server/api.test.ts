import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createApi, type ApiOptions } from './api.ts'
import { fileStore, postgresStore, type Store } from './store.ts'

// A fake Google: the "credential" is just the email address.
const fakeGoogle: ApiOptions['verifyGoogle'] = async (credential) => {
  if (!credential.includes('@')) throw new Error('bad token')
  return { email: credential.toLowerCase(), name: credential.split('@')[0] }
}

async function serve(store: Store, googleClientId = 'test-client') {
  const app = express()
  app.use('/api', createApi({ store, googleClientId, verifyGoogle: fakeGoogle, secret: 'test-secret-0123456789' }))
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const call = async (method: string, path: string, opts: { body?: unknown; account?: string; bearer?: string } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(opts.account ? { 'X-Wayneday-Account': opts.account } : {}),
        ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any }
  }
  const signIn = async (email: string) => (await call('POST', '/auth/google', { body: { credential: email } })).body.token as string
  return { call, signIn, close: () => server.close() }
}

const stores: [string, () => Promise<Store>][] = [
  [
    'files',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wayneday-'))
      after(() => rmSync(dir, { recursive: true, force: true }))
      return fileStore(dir)
    },
  ],
]
if (process.env.TEST_DATABASE_URL) stores.push(['postgres', () => postgresStore(process.env.TEST_DATABASE_URL!)])

for (const [kind, makeStore] of stores) {
  describe(`API with ${kind} storage`, async () => {
    const store = await makeStore()
    const { call, signIn, close } = await serve(store)
    after(close)

    test('hosting needs Google sign-in; the creator becomes the owner', async () => {
      assert.equal((await call('GET', '/config')).body.googleClientId, 'test-client')
      assert.equal((await call('POST', '/sessions', { body: { title: 'Ward' } })).status, 401)
      assert.equal((await call('POST', '/auth/google', { body: { credential: 'nope' } })).status, 401)
      const alice = await signIn('Alice@Example.com')
      const created = await call('POST', '/sessions', { body: { title: 'Ward' }, account: alice })
      assert.equal(created.status, 200)
      const v = (await call('GET', `/sessions/${created.body.code}`, { account: alice })).body
      assert.equal(v.me.hostRole, 'owner')
      assert.deepEqual(v.hosts.map((h: { email: string }) => h.email), ['alice@example.com'])
      const anon = (await call('GET', `/sessions/${created.body.code}`)).body
      assert.equal(anon.me.isHost, false)
      assert.equal(anon.hosts, undefined, 'host emails are hidden from members')
      assert.equal(JSON.stringify(anon).includes('alice@example.com'), false)
    })

    test('the owner adds and removes co-hosts; co-hosts can leave but not add', async () => {
      const alice = await signIn('alice@example.com')
      const bob = await signIn('bob@example.com')
      const { code } = (await call('POST', '/sessions', { body: { title: 'Nights' }, account: alice })).body
      assert.equal((await call('GET', `/sessions/${code}`, { account: bob })).body.me.isHost, false)
      assert.equal((await call('PUT', `/sessions/${code}/config`, { body: { title: 'x' }, account: bob })).status, 403)

      assert.equal((await call('POST', `/sessions/${code}/hosts`, { body: { action: 'add', email: 'not-an-email' }, account: alice })).status, 400)
      assert.equal((await call('POST', `/sessions/${code}/hosts`, { body: { action: 'add', email: ' Bob@Example.com ' }, account: alice })).status, 200)
      // Members see who runs it by name only; a co-host who hasn't signed in yet has no name to show.
      const member = (await call('GET', `/sessions/${code}`)).body
      assert.deepEqual(member.organizers, [{ name: 'alice', role: 'owner' }, { name: '', role: 'cohost' }])
      assert.equal(JSON.stringify(member).includes('@example.com'), false)
      const asBob = (await call('GET', `/sessions/${code}`, { account: bob })).body
      assert.equal(asBob.me.hostRole, 'cohost')
      assert.equal(asBob.hosts.find((h: { email: string }) => h.email === 'bob@example.com').name, 'bob', 'their Google name replaces the email')
      assert.deepEqual((await call('GET', `/sessions/${code}`)).body.organizers, [{ name: 'alice', role: 'owner' }, { name: 'bob', role: 'cohost' }])
      assert.equal((await call('PUT', `/sessions/${code}/config`, { body: { title: 'Nights v2' }, account: bob })).status, 200)
      assert.equal((await call('POST', `/sessions/${code}/hosts`, { body: { action: 'add', email: 'carol@example.com' }, account: bob })).status, 403)
      assert.equal((await call('POST', `/sessions/${code}/hosts`, { body: { action: 'remove', email: 'alice@example.com' }, account: bob })).status, 400)

      const mine = (await call('GET', '/me', { account: bob })).body.sessions
      assert.ok(mine.some((s: { code: string; role: string; title: string }) => s.code === code && s.role === 'cohost' && s.title === 'Nights v2'))

      assert.equal((await call('POST', `/sessions/${code}/hosts`, { body: { action: 'remove', email: 'bob@example.com' }, account: bob })).status, 200)
      assert.equal((await call('GET', `/sessions/${code}`, { account: bob })).body.me.isHost, false)
      assert.equal((await call('GET', '/me')).status, 401)
    })

    test('a forged account token is ignored', async () => {
      const alice = await signIn('alice@example.com')
      const { code } = (await call('POST', '/sessions', { body: {}, account: alice })).body
      const [body] = alice.split('.')
      const forged = `${Buffer.from(JSON.stringify({ email: 'alice@example.com', name: 'x', exp: Date.now() + 1e9 })).toString('base64url')}.${body}`
      assert.equal((await call('GET', `/sessions/${code}`, { account: forged })).body.me.isHost, false)
    })

    test('parallel saves are all kept, and polling skips unchanged sessions', async () => {
      const alice = await signIn('alice@example.com')
      const { code } = (await call('POST', '/sessions', { body: {}, account: alice })).body
      const members = ['a', 'b', 'c', 'd'].map((n) => ({ id: n, name: n, type: 'student', jobs: [] }))
      await call('PUT', `/sessions/${code}/config`, { body: { members }, account: alice })
      const tokens = await Promise.all(
        members.map(async (m) => (await call('POST', `/sessions/${code}/claim`, { body: { memberId: m.id, pin: '1234' } })).body.memberToken as string),
      )
      await Promise.all(
        members.map((m, i) => call('PUT', `/sessions/${code}/responses/${m.id}`, { body: { minInterval: i + 2 }, bearer: tokens[i] })),
      )
      const v = (await call('GET', `/sessions/${code}`)).body
      assert.deepEqual(members.map((m) => v.session.responses[m.id]?.minInterval), [2, 3, 4, 5])
      assert.deepEqual((await call('GET', `/sessions/${code}?since=${v.session.version}`)).body, { unchanged: true })
      assert.ok((await call('GET', `/sessions/${code}?since=${v.session.version - 1}`)).body.session)
    })

    test('point settings and per-date points are kept (and cleaned)', async () => {
      const alice = await signIn('alice@example.com')
      const { code } = (await call('POST', '/sessions', { body: {}, account: alice })).body
      const shifts = [{ id: 'oc', name: 'On call', start: '16:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6], requirements: [] }]
      const v = (
        await call('PUT', `/sessions/${code}/config`, {
          account: alice,
          body: {
            shifts,
            students: {
              points: {
                on: true, weekday: 1, weekend: '2.5', shifts: { oc: 1.5, gone: 3 },
                fixed: { 'oc|weekend': 4, 'oc|2025-12-24': '6', 'oc|someday': 1, 'gone|weekday': 2 },
              },
            },
            datePoints: { '2025-12-03': 3, nope: 9 },
          },
        })
      ).body
      assert.deepEqual(v.session.config.students.points, { on: true, weekday: 1, weekend: 2.5, shifts: { oc: 1.5 }, fixed: { 'oc|weekend': 4, 'oc|2025-12-24': 6 } })
      assert.deepEqual(v.session.config.datePoints, { '2025-12-03': 3 })
    })

    test('long shifts, presenter sources and one-day presentations are kept (and cleaned)', async () => {
      const alice = await signIn('alice@example.com')
      const { code } = (await call('POST', '/sessions', { body: {}, account: alice })).body
      const shifts = [
        { id: 'n', name: 'Night', start: '16:00', end: '08:00', days: [1], requirements: [{ id: 'wa', jobId: '', count: 1 }, { id: 'wb', jobId: '', count: 1 }] },
        { id: 'l', name: 'Long', start: '08:00', end: '20:00', endDays: 1, days: [6], requirements: [] },
      ]
      const presentations = [
        { id: 'case', name: 'Case', days: [], dates: ['2026-11-10', 'bad'], count: 2, fromShiftId: 'n', fromCount: 1, types: ['student'],
          sources: [{ shiftId: 'n', placeId: 'wa', count: 1 }, { shiftId: 'n', placeId: 'nope', count: 1, when: 'same' }, { shiftId: 'gone', count: 1 }] },
      ]
      const jobs = [{ id: 'j17', name: '17C' }]
      ;(presentations[0].sources as object[]).push({ shiftId: '*', jobId: 'j17', count: 1 }, { shiftId: '*', jobId: 'gone', count: 1 })
      ;(presentations[0] as Record<string, unknown>).daysBack = [3, '2']
      const presentationOverrides = [
        { date: '2026-11-10', ruleId: 'case', active: true, daysBack: [1, 1] },
        { date: '2026-11-11', ruleId: 'case', active: true, daysBack: [9] },
      ]
      const v = (await call('PUT', `/sessions/${code}/config`, { account: alice, body: { jobs, shifts, presentations, presentationOverrides } })).body
      assert.equal(v.session.config.shifts[1].endDays, 1)
      assert.equal(v.session.config.shifts[0].endDays, undefined)
      const r = v.session.config.presentations[0]
      assert.deepEqual(r.dates, ['2026-11-10'])
      assert.deepEqual(r.daysBack, [2, 3])
      assert.deepEqual(v.session.config.presentationOverrides.map((o: { daysBack?: number[] }) => o.daysBack), [[1, 1], undefined])
      assert.deepEqual(r.sources, [
        { shiftId: 'n', placeId: 'wa', count: 1, when: 'before' },
        { shiftId: 'n', count: 1, when: 'same' },
        { shiftId: '*', jobId: 'j17', count: 1, when: 'before' },
        { shiftId: '*', count: 1, when: 'before' },
      ])
    })

    test('dated places are kept (and cleaned)', async () => {
      const alice = await signIn('alice@example.com')
      const { code } = (await call('POST', '/sessions', { body: {}, account: alice })).body
      const jobs = [{ id: 'a', name: 'Ward A' }, { id: 'b', name: 'Ward B' }]
      const periods = [
        { jobId: 'a', from: '2026-11-01', to: '2026-11-15' },
        { jobId: 'b', from: '2026-11-30', to: '2026-11-16' },
        { jobId: 'gone', from: '2026-11-01', to: '2026-11-02' },
        { jobId: 'a', from: 'bad', to: '2026-11-02' },
      ]
      const members = [{ id: 'm', name: 'M', type: 'student', jobs: [], periods }, { id: 'n', name: 'N', type: 'student', jobs: [], periods: [] }]
      const v = (await call('PUT', `/sessions/${code}/config`, { account: alice, body: { jobs, members } })).body
      assert.deepEqual(v.session.config.members[0].periods, [
        { jobId: 'a', from: '2026-11-01', to: '2026-11-15' },
        { jobId: 'b', from: '2026-11-16', to: '2026-11-30' },
      ])
      assert.equal(v.session.config.members[1].periods, undefined)
    })

    test('"I’m ready!" is kept with the answers, and can be taken back', async () => {
      const alice = await signIn('alice@example.com')
      const { code } = (await call('POST', '/sessions', { body: {}, account: alice })).body
      await call('PUT', `/sessions/${code}/config`, { body: { members: [{ id: 'm', name: 'M', type: 'student' }, { id: 'n', name: 'N', type: 'student' }] }, account: alice })
      const claim = async (id: string) => (await call('POST', `/sessions/${code}/claim`, { body: { memberId: id, pin: '1234' } })).body.memberToken as string
      const [m, n] = [await claim('m'), await claim('n')]
      const at = Date.now() - 1000
      await call('PUT', `/sessions/${code}/responses/m`, { body: { minInterval: 3, ready: at }, bearer: m })
      await call('PUT', `/sessions/${code}/responses/n`, { body: { ready: 'soon' }, bearer: n })
      let v = (await call('GET', `/sessions/${code}`)).body
      assert.equal(v.session.responses.m.ready, at)
      assert.equal(v.session.responses.n.ready, undefined)
      await call('PUT', `/sessions/${code}/responses/m`, { body: { minInterval: 3 }, bearer: m })
      v = (await call('GET', `/sessions/${code}`)).body
      assert.equal(v.session.responses.m.ready, undefined)
    })

    test('the hospital roster can be left blank', async () => {
      const alice = await signIn('alice@example.com')
      const { code } = (await call('POST', '/sessions', { body: {}, account: alice })).body
      let v = (await call('PUT', `/sessions/${code}/config`, { account: alice, body: { noDuty: true } })).body
      assert.equal(v.session.config.noDuty, true)
      v = (await call('PUT', `/sessions/${code}/config`, { account: alice, body: { noDuty: 'yes' } })).body
      assert.equal(v.session.config.noDuty, undefined)
    })

    test('PIN guessing is slowed down per name', async () => {
      const alice = await signIn('alice@example.com')
      const { code } = (await call('POST', '/sessions', { body: {}, account: alice })).body
      await call('PUT', `/sessions/${code}/config`, { body: { members: [{ id: 'm', name: 'M', type: 'student' }] }, account: alice })
      assert.equal((await call('POST', `/sessions/${code}/claim`, { body: { memberId: 'm', pin: '1111' } })).status, 200)
      const statuses = []
      for (let i = 0; i < 9; i++) statuses.push((await call('POST', `/sessions/${code}/claim`, { body: { memberId: 'm', pin: '9999' } })).status)
      assert.deepEqual(statuses.slice(0, 7), Array(7).fill(401))
      assert.equal(statuses.at(-1), 429)
    })
  })
}

test('with a host list, only listed accounts (or domains) can create sessions; co-hosts still work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wayneday-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const app = express()
  app.use('/api', createApi({ store: fileStore(dir), googleClientId: 'c', verifyGoogle: fakeGoogle, secret: 'x'.repeat(32), hostAllowlist: ['Me@Gmail.com', '@docchula.com'] }))
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const post = async (path: string, account: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wayneday-Account': account }, body: JSON.stringify(body) })
  const signIn = async (email: string) =>
    ((await (await fetch(`${base}/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: email }) })).json()) as { token: string }).token
  const me = await signIn('me@gmail.com')
  const chula = await signIn('friend@docchula.com')
  const stranger = await signIn('stranger@gmail.com')
  assert.equal((await post('/sessions', stranger, {})).status, 403)
  assert.equal((await post('/sessions', chula, {})).status, 200)
  const created = await post('/sessions', me, {})
  assert.equal(created.status, 200)
  const { code } = (await created.json()) as { code: string }
  const meInfo = (await (await fetch(`${base}/me`, { headers: { 'X-Wayneday-Account': stranger } })).json()) as { canHost: boolean }
  assert.equal(meInfo.canHost, false)
  // The stranger can still be a co-host on someone's roster.
  assert.equal((await post(`/sessions/${code}/hosts`, me, { action: 'add', email: 'stranger@gmail.com' })).status, 200)
  const v = (await (await fetch(`${base}/sessions/${code}`, { headers: { 'X-Wayneday-Account': stranger } })).json()) as { me: { hostRole: string } }
  assert.equal(v.me.hostRole, 'cohost')
})

test('a session made before sign-in gets its signed-in host as owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wayneday-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const store = fileStore(dir)
  const old = await serve(store, '')
  const { code, hostToken } = (await old.call('POST', '/sessions', { body: { title: 'Old' } })).body
  old.close()
  const now = await serve(store)
  after(now.close)
  const alice = await now.signIn('alice@example.com')
  const v = (await now.call('GET', `/sessions/${code}`, { bearer: hostToken, account: alice })).body
  assert.equal(v.me.hostRole, 'owner')
  assert.equal((await now.call('GET', `/sessions/${code}`, { account: alice })).body.me.hostRole, 'owner', 'works without the device token now')
})
