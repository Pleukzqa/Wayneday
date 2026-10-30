import type { SessionView } from './apiTypes.ts'
import type { MemberResponse, Schedule, SessionConfig } from './shared/types.ts'

export type { Me, SessionView } from './apiTypes.ts'

interface Tokens {
  hostToken?: string
  memberToken?: string
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
  const { hostToken } = getTokens(code)
  try {
    localStorage.setItem(key(code), JSON.stringify({ hostToken }))
  } catch {
    // ignore
  }
}

async function call<T>(code: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const t = code ? getTokens(code) : {}
  const auth = [t.hostToken, t.memberToken].filter(Boolean).join(',')
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data
}

export const api = {
  create: (title: string) => call<{ code: string; hostToken: string }>(null, 'POST', '/sessions', { title }),
  get: (code: string) => call<SessionView>(code, 'GET', `/sessions/${code}`),
  saveConfig: (code: string, config: SessionConfig) => call<SessionView>(code, 'PUT', `/sessions/${code}/config`, config),
  claim: (code: string, memberId: string, pin: string) =>
    call<{ memberToken: string }>(code, 'POST', `/sessions/${code}/claim`, { memberId, pin }),
  resetClaim: (code: string, memberId: string) => call<SessionView>(code, 'DELETE', `/sessions/${code}/claim/${memberId}`),
  saveResponse: (code: string, memberId: string, r: MemberResponse) =>
    call<SessionView>(code, 'PUT', `/sessions/${code}/responses/${memberId}`, r),
  saveSchedule: (code: string, s: Schedule | null) => call<SessionView>(code, 'PUT', `/sessions/${code}/schedule`, s),
  addConcern: (code: string, text: string, date?: string, shiftId?: string) =>
    call<SessionView>(code, 'POST', `/sessions/${code}/concerns`, { text, date, shiftId }),
  resolveConcern: (code: string, id: string, resolved: boolean) =>
    call<SessionView>(code, 'PATCH', `/sessions/${code}/concerns/${id}`, { resolved }),
}
