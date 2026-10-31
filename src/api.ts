import { accountToken, type Account } from './account.ts'
import type { MySession, SessionView } from './apiTypes.ts'
import type { SwapAction } from './shared/ops.ts'
import type { MemberResponse, MemberType, Roster, Schedule, SessionConfig } from './shared/types.ts'

export type { HostInfo, Me, MySession, SessionView } from './apiTypes.ts'

interface Tokens {
  hostToken?: string
  memberToken?: string
  requestToken?: string
}

const key = (code: string) => `wayneday:${code}`

export function getTokens(code: string): Tokens {
  try {
    return JSON.parse(localStorage.getItem(key(code)) ?? '{}') as Tokens
  } catch {
    return {}
  }
}

export function setTokens(code: string, t: Tokens) {
  try {
    localStorage.setItem(key(code), JSON.stringify({ ...getTokens(code), ...t }))
  } catch {
    // Private mode: the login lasts for this tab only.
  }
}

export function forgetMember(code: string) {
  const { hostToken } = getTokens(code) // also drops a pending join request
  try {
    localStorage.setItem(key(code), JSON.stringify({ hostToken }))
  } catch {
    // ignore
  }
}

async function call<T>(code: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const t = code ? getTokens(code) : {}
  const auth = [t.hostToken, t.memberToken, t.requestToken].filter(Boolean).join(',')
  const account = accountToken()
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(account ? { 'X-Wayneday-Account': account } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data
}

export const api = {
  create: (title: string) => call<{ code: string; hostToken: string }>(null, 'POST', '/sessions', { title }),
  config: () => call<{ googleClientId: string }>(null, 'GET', '/config'),
  signInGoogle: (credential: string) => call<{ token: string; account: Account }>(null, 'POST', '/auth/google', { credential }),
  mySessions: () => call<{ account: Account; canHost: boolean; sessions: MySession[] }>(null, 'GET', '/me'),
  /** With `since`, answers { unchanged: true } if the session is still at that version. */
  get: (code: string, since = -1) =>
    call<SessionView | { unchanged: true }>(code, 'GET', `/sessions/${code}${since >= 0 ? `?since=${since}` : ''}`),
  setHost: (code: string, action: 'add' | 'remove', email: string) => call<SessionView>(code, 'POST', `/sessions/${code}/hosts`, { action, email }),
  saveConfig: (code: string, config: SessionConfig) => call<SessionView>(code, 'PUT', `/sessions/${code}/config`, config),
  claim: (code: string, memberId: string, pin: string) =>
    call<{ memberToken: string }>(code, 'POST', `/sessions/${code}/claim`, { memberId, pin }),
  resetClaim: (code: string, memberId: string) => call<SessionView>(code, 'DELETE', `/sessions/${code}/claim/${memberId}`),
  /** `hostReason`: why a host changed someone else's answers; they're sent it as a note. */
  saveResponse: (code: string, memberId: string, r: MemberResponse, hostReason?: string) =>
    call<SessionView>(code, 'PUT', `/sessions/${code}/responses/${memberId}`, hostReason ? { ...r, hostReason } : r),
  saveSchedule: (code: string, s: Schedule | null) => call<SessionView>(code, 'PUT', `/sessions/${code}/schedule`, s),
  addConcern: (code: string, text: string, date?: string, shiftId?: string) =>
    call<SessionView>(code, 'POST', `/sessions/${code}/concerns`, { text, date, shiftId }),
  /** Hosts: keep (or with null, drop) the arrangement being tried out. */
  saveDraft: (code: string, draft: { roster: Roster; source: Schedule['source']; notes: string[] } | null) =>
    call<SessionView>(code, 'PUT', `/sessions/${code}/draft`, draft ?? {}),
  saveFeedback: (code: string, f: { ratings: Record<string, number>; text: string; anonymous: boolean }) =>
    call<SessionView>(code, 'PUT', `/sessions/${code}/feedback`, f),
  addNote: (code: string, memberId: string, text: string) => call<SessionView>(code, 'POST', `/sessions/${code}/notes`, { memberId, text }),
  removeNote: (code: string, id: string) => call<SessionView>(code, 'DELETE', `/sessions/${code}/notes/${id}`),
  readNote: (code: string, id: string) => call<SessionView>(code, 'POST', `/sessions/${code}/notes/${id}/read`),
  resolveConcern: (code: string, id: string, resolved: boolean) =>
    call<SessionView>(code, 'PATCH', `/sessions/${code}/concerns/${id}`, { resolved }),
  requestSwap: (code: string, body: { date: string; shiftId: string; requirementId: string; note: string }) =>
    call<SessionView>(code, 'POST', `/sessions/${code}/swaps`, body),
  actOnSwap: (code: string, id: string, action: SwapAction) => call<SessionView>(code, 'POST', `/sessions/${code}/swaps/${id}`, action),
  requestJoin: (code: string, name: string, type: MemberType, pin: string) =>
    call<{ requestToken: string }>(code, 'POST', `/sessions/${code}/join`, { name, type, pin }),
  decideJoin: (code: string, id: string, approve: boolean, memberId?: string) =>
    call<SessionView>(code, 'POST', `/sessions/${code}/join/${id}`, { approve, memberId }),
}
