// Session changes shared by the API server and the in-browser demo, so both enforce the same rules.
import { STUDENT_SLOT, type AnswerChange, type JoinRequest, type MemberResponse, type MemberType, type PublicSession, type Roster, type SwapRequest } from './types.ts'

export interface Actor {
  isHost: boolean
  memberId: string | null
}

export class OpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const newId = () => Math.random().toString(36).slice(2, 10)

// ---------- answers ----------

function summarize(before: MemberResponse | null, after: MemberResponse): string {
  const parts: string[] = []
  const b: Pick<MemberResponse, 'unavailable' | 'locks' | 'minInterval' | 'preference' | 'note'> = before ?? {
    unavailable: [],
    locks: [],
    minInterval: after.minInterval,
    preference: after.preference,
    note: '',
  }
  const added = after.unavailable.filter((d) => !b.unavailable.includes(d))
  const removed = b.unavailable.filter((d) => !after.unavailable.includes(d))
  if (added.length) parts.push(`marked ${added.length} day(s) unavailable`)
  if (removed.length) parts.push(`cleared ${removed.length} unavailable day(s)`)
  const lockKey = (l: { date: string; shiftId: string }) => `${l.date}|${l.shiftId}`
  const lAdded = after.locks.filter((l) => !b.locks.some((x) => lockKey(x) === lockKey(l)))
  const lRemoved = b.locks.filter((l) => !after.locks.some((x) => lockKey(x) === lockKey(l)))
  if (lAdded.length) parts.push(`added ${lAdded.length} lock(s)`)
  if (lRemoved.length) parts.push(`removed ${lRemoved.length} lock(s)`)
  if (b.minInterval !== after.minInterval) parts.push(`interval ${b.minInterval}→${after.minInterval} days`)
  if (b.preference !== after.preference) parts.push(`pattern → ${after.preference === 'dense' ? 'grouped' : 'spread out'}`)
  if (b.note !== after.note) parts.push('edited the note')
  return parts.join(', ') || 'no visible change'
}

export function saveResponse(s: PublicSession, actor: Actor, memberId: string, r: MemberResponse) {
  if (!actor.isHost && actor.memberId !== memberId) throw new OpError(403, 'You can only edit your own answers')
  if (!s.config.members.some((m) => m.id === memberId)) throw new OpError(404, 'No such member')
  if (s.schedule?.status === 'final' && !actor.isHost) throw new OpError(409, 'The roster is final')
  const before = s.responses[memberId] ?? null
  const byHostForOther = actor.isHost && actor.memberId !== memberId
  const next: MemberResponse = { ...r, updatedAt: Date.now(), editedByHost: byHostForOther ? Date.now() : before?.editedByHost }
  if (byHostForOther) {
    // Host edits to the same person within 2 minutes merge into one entry, keeping the original "before".
    const last = s.changes[s.changes.length - 1]
    if (last && last.memberId === memberId && Date.now() - last.at < 120_000) {
      last.at = Date.now()
      last.summary = summarize(last.before, next)
    } else {
      const change: AnswerChange = { id: newId(), memberId, at: Date.now(), before, summary: summarize(before, next) }
      s.changes = [...s.changes.slice(-199), change]
    }
  }
  s.responses[memberId] = next
}

// ---------- swaps ----------

type Place = { date: string; shiftId: string; requirementId: string }

/** Where a member's place sits in a roster: a position, or (requirementId = STUDENT_SLOT) a student spot. */
function findPlace(r: Roster, memberId: string, x: Place, skip?: { list: 'a' | 's'; i: number }) {
  if (x.requirementId === STUDENT_SLOT) {
    const i = r.students.findIndex((a, k) => !(skip?.list === 's' && skip.i === k) && a.memberId === memberId && a.date === x.date && a.shiftId === x.shiftId)
    return i < 0 ? null : { list: 's' as const, i }
  }
  const i = r.assignments.findIndex(
    (a, k) => !(skip?.list === 'a' && skip.i === k) && a.memberId === memberId && a.date === x.date && a.shiftId === x.shiftId && a.requirementId === x.requirementId,
  )
  return i < 0 ? null : { list: 'a' as const, i }
}

function ownsShift(s: PublicSession, memberId: string, x: Place) {
  return Boolean(s.schedule && findPlace(s.schedule, memberId, x))
}

/** The roster with a swap applied (the asker's place goes to the offerer, and the offered place, if any, to the asker). */
export function applySwapPreview<R extends Roster>(roster: R, swap: SwapRequest, offerId: string): R {
  const offer = swap.offers.find((o) => o.id === offerId)
  if (!offer) return roster
  const out = { ...roster, assignments: roster.assignments.map((a) => ({ ...a })), students: roster.students.map((a) => ({ ...a })) }
  const set = (p: { list: 'a' | 's'; i: number }, memberId: string) => {
    if (p.list === 'a') out.assignments[p.i].memberId = memberId
    else out.students[p.i].memberId = memberId
  }
  const take = findPlace(roster, swap.memberId, swap)
  const give = offer.give ? findPlace(roster, offer.memberId, offer.give, take ?? undefined) : null
  if (take) set(take, offer.memberId)
  if (give) set(give, swap.memberId)
  return out
}

export function requestSwap(
  s: PublicSession,
  actor: Actor,
  body: { date: string; shiftId: string; requirementId: string; note: string },
): SwapRequest {
  if (!actor.memberId) throw new OpError(401, 'Log in to ask for a swap')
  if (!s.schedule) throw new OpError(409, 'There is no roster yet')
  if (!ownsShift(s, actor.memberId, body)) throw new OpError(409, 'That shift isn’t yours in the current roster')
  if (s.swaps.some((x) => x.memberId === actor.memberId && x.date === body.date && x.shiftId === body.shiftId && (x.status === 'open' || x.status === 'agreed'))) {
    throw new OpError(409, 'You already asked to swap that shift')
  }
  const req: SwapRequest = {
    id: newId(),
    memberId: actor.memberId,
    date: body.date,
    shiftId: body.shiftId,
    requirementId: body.requirementId,
    note: body.note.slice(0, 500),
    status: 'open',
    offers: [],
    createdAt: Date.now(),
  }
  s.swaps = [...s.swaps.slice(-299), req]
  return req
}

export type SwapAction =
  | { action: 'offer'; give?: { date: string; shiftId: string; requirementId: string } }
  | { action: 'withdraw' }
  | { action: 'accept'; offerId: string }
  | { action: 'approve' }
  | { action: 'decline' }
  | { action: 'cancel' }

export function actOnSwap(s: PublicSession, actor: Actor, swapId: string, a: SwapAction) {
  const swap = s.swaps.find((x) => x.id === swapId)
  if (!swap) throw new OpError(404, 'No such swap request')
  const live = swap.status === 'open' || swap.status === 'agreed'
  switch (a.action) {
    case 'offer': {
      if (!actor.memberId) throw new OpError(401, 'Log in to offer')
      if (actor.memberId === swap.memberId) throw new OpError(409, 'You can’t take your own shift')
      if (swap.status !== 'open') throw new OpError(409, 'This request is no longer open')
      if (a.give && !ownsShift(s, actor.memberId, a.give)) throw new OpError(409, 'The shift you offered isn’t yours')
      swap.offers = [
        ...swap.offers.filter((o) => o.memberId !== actor.memberId),
        { id: newId(), memberId: actor.memberId, ...(a.give ? { give: a.give } : {}), createdAt: Date.now() },
      ]
      return
    }
    case 'withdraw':
      if (swap.status !== 'open') throw new OpError(409, 'This request is no longer open')
      swap.offers = swap.offers.filter((o) => o.memberId !== actor.memberId)
      return
    case 'accept':
      if (actor.memberId !== swap.memberId) throw new OpError(403, 'Only the person who asked can accept')
      if (swap.status !== 'open') throw new OpError(409, 'This request is no longer open')
      if (!swap.offers.some((o) => o.id === a.offerId)) throw new OpError(404, 'No such offer')
      swap.acceptedOfferId = a.offerId
      swap.status = 'agreed'
      return
    case 'approve': {
      if (!actor.isHost) throw new OpError(403, 'Only the host can approve swaps')
      if (swap.status !== 'agreed') throw new OpError(409, 'Both people need to agree first')
      const offer = swap.offers.find((o) => o.id === swap.acceptedOfferId)!
      const sched = s.schedule
      if (!sched || !ownsShift(s, swap.memberId, swap) || (offer.give && !ownsShift(s, offer.memberId, offer.give))) {
        throw new OpError(409, 'The roster changed since this swap was agreed; it can no longer be applied')
      }
      s.schedule = applySwapPreview(sched, swap, offer.id)
      // Presenter duties stay with whoever was picked; re-arrange presenters to recompute them.
      swap.status = 'approved'
      swap.resolvedAt = Date.now()
      return
    }
    case 'decline':
      if (!actor.isHost) throw new OpError(403, 'Only the host can decline swaps')
      if (!live) throw new OpError(409, 'This request is closed')
      swap.status = 'declined'
      swap.resolvedAt = Date.now()
      return
    case 'cancel':
      if (!actor.isHost && actor.memberId !== swap.memberId) throw new OpError(403, 'Only the person who asked can cancel')
      if (!live) throw new OpError(409, 'This request is closed')
      swap.status = 'cancelled'
      swap.resolvedAt = Date.now()
      return
  }
}

/** The roster as it would be if this swap (with this offer) were applied. */
// ---------- joining ----------

export function createJoin(s: PublicSession, name: string, type: MemberType): JoinRequest {
  const clean = name.trim().slice(0, 60)
  if (!clean) throw new OpError(400, 'Enter your name')
  const req: JoinRequest = { id: newId(), name: clean, type, status: 'pending', createdAt: Date.now() }
  s.joinRequests = [...s.joinRequests.slice(-99), req]
  return req
}

/** Approve by linking to an existing person (`memberId`) or adding a new one. Returns the member id. */
export function decideJoin(s: PublicSession, actor: Actor, id: string, approve: boolean, memberId?: string): string | null {
  if (!actor.isHost) throw new OpError(403, 'Only the host can approve people')
  const req = s.joinRequests.find((r) => r.id === id)
  if (!req || req.status !== 'pending') throw new OpError(404, 'No pending request')
  if (!approve) {
    req.status = 'rejected'
    return null
  }
  let target = memberId
  if (target) {
    if (!s.config.members.some((m) => m.id === target)) throw new OpError(404, 'No such person')
  } else {
    target = newId()
    s.config.members = [...s.config.members, { id: target, name: req.name, type: req.type, jobs: [] }]
  }
  req.status = 'approved'
  req.memberId = target
  if (!s.claimed.includes(target)) s.claimed = [...s.claimed, target]
  return target
}
