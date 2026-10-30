// The host's Google account on this device: the server's account token plus name, email and picture.

import { useSyncExternalStore } from 'react'

export interface Account {
  email: string
  name: string
  picture?: string
}
interface Stored {
  token: string
  account: Account
}

const KEY = 'wayneday:account'

function read(): Stored | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null
    return s?.token && s.account?.email ? s : null
  } catch {
    return null
  }
}

let current = read()
const listeners = new Set<() => void>()

export const accountToken = () => current?.token
export const getAccount = () => current?.account ?? null

export function setAccount(s: Stored | null) {
  current = s
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s))
    else localStorage.removeItem(KEY)
  } catch {
    // Private mode: signed in for this tab only.
  }
  for (const l of listeners) l()
}

export function onAccountChange(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export const useAccount = () => useSyncExternalStore(onAccountChange, getAccount)
