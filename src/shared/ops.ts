// Session changes shared by the API server and the in-browser demo, so both enforce the same rules.
import { followShifts } from './students.ts'
import { DEFAULT_RESPONSE, FEEDBACK_QUESTIONS, missingReasons, STUDENT_SLOT, type AnswerChange, type Concern, type Draft, type Feedback, type HostNote, type JoinRequest, type MemberResponse, type MemberType, type PublicSession, type Roster, type SwapRequest } from './types.ts'

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
  // No answers yet = the defaults everyone starts with.
  const b: Pick<MemberResponse, 'unavailable' | 'locks' | 'minInterval' | 'preference' | 'note'> = before ?? DEFAULT_RESPONSE
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
  if (JSON.stringify(before?.reasons ?? {}) !== JSON.stringify(after.reasons ?? {})) parts.push('edited reasons')
  if (Boolean(before?.ready) !== Boolean(after.ready)) parts.push(after.ready ? 'marked ready' : 'marked not ready')
  return parts.join(', ') || 'no visible change'
}

/** A host changing someone else's answers says why, and who they are (for the note the member gets). */
export type HostEdit = { reason: string } & Pick<HostNote, 'by' | 'role'>

export function saveResponse(s: PublicSession, actor: Actor, memberId: string, r: MemberResponse, hostEdit?: HostEdit) {
  if (!actor.isHost && actor.memberId !== memberId) throw new OpError(403, 'You can only edit your own answers')
  if (!s.config.members.some((m) => m.id === memberId)) throw new OpError(404, 'No such member')
  if (s.schedule?.status === 'final' && !actor.isHost) throw new OpError(409, 'The roster is final')
  const before = s.responses[memberId] ?? null
  const byHostForOther = actor.isHost && actor.memberId !== memberId
  const next: MemberResponse = { ...r, updatedAt: Date.now(), editedByHost: byHostForOther ? Date.now() : before?.editedByHost }
  // ✕, !!! and !! need a reason before "I'm ready!"; a new one without a reason makes them not ready again.
  if (!byHostForOther && next.ready && missingReasons(next).length) {
    if (!before?.ready) throw new OpError(400, 'Write why for each ✕, !!! and !! day first')
    delete next.ready
  }
  if (byHostForOther) {
    // Host edits to the same person within 2 minutes merge into one entry, keeping the original "before".
    const reason = hostEdit?.reason.trim().slice(0, 500) || undefined
    let change: AnswerChange | undefined = s.changes[s.changes.length - 1]
    if (change && change.memberId === memberId && Date.now() - change.at < 120_000) {
      change.at = Date.now()
      change.summary = summarize(change.before, next)
      if (reason) change.reason = reason
    } else {
      change = { id: newId(), memberId, at: Date.now(), before, summary: summarize(before, next), ...(reason ? { reason } : {}) }
      s.changes = [...s.changes.slice(-199), change]
    }
    // With a reason, the member gets a note on every page (one per change, kept up to date as the host goes on editing).
    if (change.reason && hostEdit) {
      const note = (s.notes ?? []).find((n) => n.change?.id === change.id)
      const text = change.reason
      if (note) Object.assign(note, { text, at: Date.now(), readAt: undefined, change: { id: change.id, summary: change.summary } })
      else addNote(s, actor, memberId, text, { by: hostEdit.by, role: hostEdit.role })
      const added = note ?? s.notes[s.notes.length - 1]
      added.change = { id: change.id, summary: change.summary }
    }
  }
  s.responses[memberId] = next
}

// ---------- host notes ----------

/** A host's message to one member. Only that member and the hosts ever see it (see visibleNotes). */
export function addNote(s: PublicSession, actor: Actor, memberId: string, text: string, by: Pick<HostNote, 'by' | 'role'>) {
  if (!actor.isHost) throw new OpError(403, 'Only hosts can leave notes')
  if (!s.config.members.some((m) => m.id === memberId)) throw new OpError(404, 'No such member')
  const clean = text.trim().slice(0, 1000)
  if (!clean) throw new OpError(400, 'Write something first')
  s.notes = [...(s.notes ?? []).slice(-499), { id: newId(), memberId, text: clean, ...by, at: Date.now() }]
}

export function removeNote(s: PublicSession, actor: Actor, id: string) {
  if (!actor.isHost) throw new OpError(403, 'Only hosts can delete notes')
  s.notes = (s.notes ?? []).filter((n) => n.id !== id)
}

/** The member says they've seen it. */
export function readNote(s: PublicSession, actor: Actor, id: string) {
  const note = (s.notes ?? []).find((n) => n.id === id)
  if (!note) throw new OpError(404, 'No such note')
  if (actor.memberId !== note.memberId) throw new OpError(403, 'This note is for someone else')
  note.readAt ??= Date.now()
}

/** Everyone's answers, with the reasons for days off kept to the person themselves and the hosts. */
export const visibleResponses = (s: PublicSession, actor: Actor): Record<string, MemberResponse> =>
  actor.isHost
    ? s.responses
    : Object.fromEntries(Object.entries(s.responses).map(([id, r]) => [id, id === actor.memberId || !r.reasons ? r : { ...r, reasons: undefined }]))

/** The host's change log, without the reasons inside others' earlier answers. */
export const visibleChanges = (s: PublicSession, actor: Actor): AnswerChange[] =>
  actor.isHost
    ? s.changes
    : s.changes.map((c) => (c.memberId === actor.memberId || !c.before?.reasons ? c : { ...c, before: { ...c.before, reasons: undefined } }))

/** The notes a viewer may see: all for hosts, their own for a member, none for anyone else. */
export const visibleNotes = (s: PublicSession, actor: Actor) => (s.notes ?? []).filter((n) => actor.isHost || n.memberId === actor.memberId)

// ---------- concerns ----------

/** Members post while the roster is in review; hosts any time. */
function concernsOpen(s: PublicSession, actor: Actor) {
  return actor.isHost || (Boolean(s.schedule) && s.schedule!.status === 'review' && Date.now() <= s.schedule!.reviewUntil)
}

function canSee(c: Concern, actor: Actor) {
  return !c.private || actor.isHost || c.memberId === actor.memberId
}

function findConcern(s: PublicSession, actor: Actor, id: string) {
  const c = s.concerns.find((x) => x.id === id)
  if (!c || !canSee(c, actor)) throw new OpError(404, 'No such concern')
  return c
}

export function addConcern(s: PublicSession, actor: Actor, body: { text: string; date?: string; shiftId?: string; private?: boolean }) {
  if (!actor.memberId && !actor.isHost) throw new OpError(401, 'Log in to post a concern')
  if (!concernsOpen(s, actor)) throw new OpError(409, 'The concern period is closed')
  const text = body.text.trim().slice(0, 1000)
  if (!text) throw new OpError(400, 'Write something first')
  const c: Concern = {
    id: newId(),
    memberId: actor.memberId ?? 'host',
    text,
    ...(body.date ? { date: body.date } : {}),
    ...(body.shiftId ? { shiftId: body.shiftId } : {}),
    createdAt: Date.now(),
    resolved: false,
    // Private = to the hosts only; a host's own concern is for everyone.
    ...(body.private && actor.memberId ? { private: true } : {}),
  }
  s.concerns = [...s.concerns.slice(-499), c]
  return c
}

/** The poster takes their concern back (hosts can remove any). */
export function removeConcern(s: PublicSession, actor: Actor, id: string) {
  const c = findConcern(s, actor, id)
  if (!actor.isHost && c.memberId !== actor.memberId) throw new OpError(403, 'Only the person who posted it can delete it')
  s.concerns = s.concerns.filter((x) => x !== c)
}

export function resolveConcern(s: PublicSession, actor: Actor, id: string, resolved: boolean) {
  if (!actor.isHost) throw new OpError(403, 'Only the host can resolve concerns')
  findConcern(s, actor, id).resolved = resolved
}

/** Anyone who can see a concern can reply: hosts any time, members while concerns are open. */
export function replyConcern(s: PublicSession, actor: Actor, id: string, text: string, by?: Pick<HostNote, 'by' | 'role'>) {
  const c = findConcern(s, actor, id)
  if (!actor.memberId && !actor.isHost) throw new OpError(401, 'Log in to reply')
  if (!concernsOpen(s, actor)) throw new OpError(409, 'The concern period is closed')
  const clean = text.trim().slice(0, 1000)
  if (!clean) throw new OpError(400, 'Write something first')
  c.replies = [
    ...(c.replies ?? []).slice(-99),
    { id: newId(), memberId: actor.isHost ? 'host' : actor.memberId!, ...(actor.isHost && by ? { by: by.by, role: by.role } : {}), text: clean, at: Date.now() },
  ]
}

export function removeReply(s: PublicSession, actor: Actor, id: string, replyId: string) {
  const c = findConcern(s, actor, id)
  const r = (c.replies ?? []).find((x) => x.id === replyId)
  if (!r) throw new OpError(404, 'No such reply')
  if (!actor.isHost && r.memberId !== actor.memberId) throw new OpError(403, 'Only the person who wrote it can delete it')
  c.replies = (c.replies ?? []).filter((x) => x !== r)
}

/** A member agrees (1), disagrees (-1) or takes their vote back (0). Private concerns have no votes. */
export function voteConcern(s: PublicSession, actor: Actor, id: string, vote: 1 | -1 | 0) {
  const c = findConcern(s, actor, id)
  if (!actor.memberId) throw new OpError(401, 'Log in to vote')
  if (c.private) throw new OpError(400, 'Private concerns have no votes')
  if (!concernsOpen(s, actor)) throw new OpError(409, 'The concern period is closed')
  const votes = { ...(c.votes ?? {}) }
  if (vote === 0) delete votes[actor.memberId]
  else votes[actor.memberId] = vote
  c.votes = votes
}

/** What a viewer gets: others' private concerns left out, and votes as counts plus their own. */
export function visibleConcerns(s: PublicSession, actor: Actor): Concern[] {
  return s.concerns
    .filter((c) => canSee(c, actor))
    .map(({ votes, ...c }) => {
      const all = Object.entries(votes ?? {})
      const mine = actor.memberId ? votes?.[actor.memberId] : undefined
      return { ...c, up: all.filter(([, v]) => v === 1).length, down: all.filter(([, v]) => v === -1).length, ...(mine ? { votes: { [actor.memberId!]: mine } } : {}) }
    })
}

// ---------- saved arrangements ----------

export const MOST_SAVED = 10

/** Hosts keep an arrangement to look at again later. */
export function saveArrangement(s: PublicSession, actor: Actor, name: string, d: Omit<Draft, 'savedAt'>) {
  if (!actor.isHost) throw new OpError(403, 'Only hosts can save arrangements')
  const saved = s.saved ?? []
  if (saved.length >= MOST_SAVED) throw new OpError(409, `You can keep up to ${MOST_SAVED} — delete one first`)
  const n = saved.length + 1
  s.saved = [...saved, { ...d, id: newId(), name: name.trim().slice(0, 80) || `Arrangement ${n}`, savedAt: Date.now() }]
}

export function removeArrangement(s: PublicSession, actor: Actor, id: string) {
  if (!actor.isHost) throw new OpError(403, 'Only hosts can delete saved arrangements')
  s.saved = (s.saved ?? []).filter((x) => x.id !== id)
}

// ---------- feedback ----------

/** A member's feedback once the roster is final; saving again replaces it. */
export function saveFeedback(s: PublicSession, actor: Actor, f: Pick<Feedback, 'ratings' | 'text' | 'hostText' | 'anonymous'>) {
  if (!actor.memberId) throw new OpError(401, 'Log in to give feedback')
  if (s.schedule?.status !== 'final') throw new OpError(409, 'Feedback opens once the roster is final')
  const ids = new Set<string>(FEEDBACK_QUESTIONS.map((q) => q.id))
  const ratings = Object.fromEntries(
    Object.entries(f.ratings).filter(([k, v]) => ids.has(k) && Number.isInteger(v) && v >= 1 && v <= 5),
  )
  const text = f.text.trim().slice(0, 2000)
  const hostText = (f.hostText ?? '').trim().slice(0, 2000)
  if (!Object.keys(ratings).length && !text && !hostText) throw new OpError(400, 'Rate something or write a comment first')
  const entry: Feedback = { memberId: actor.memberId, ratings, text, ...(hostText ? { hostText } : {}), ...(f.anonymous ? { anonymous: true } : {}), at: Date.now() }
  s.feedback = [...(s.feedback ?? []).filter((x) => x.memberId !== actor.memberId), entry]
}

/** Hosts see everyone's (anonymous ones without the name); a member sees only their own. */
export const visibleFeedback = (s: PublicSession, actor: Actor): Feedback[] =>
  (s.feedback ?? []).flatMap((f) =>
    actor.memberId === f.memberId ? [f] : actor.isHost ? [f.anonymous ? { ...f, memberId: '' } : f] : [],
  )

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
      s.schedule = { ...applySwapPreview(sched, swap, offer.id), presenters: sched.presenters.map((p) => ({ ...p })) }
      // A presentation drawn from a traded shift goes with it (e.g. the morning round after that night).
      followShifts(s.config, [...sched.assignments, ...sched.students], [...s.schedule.assignments, ...s.schedule.students], s.schedule.presenters, [swap.memberId, offer.memberId], sched.pinned)
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
