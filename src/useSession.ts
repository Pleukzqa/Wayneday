import { useCallback, useEffect, useRef, useState } from 'react'
import { onAccountChange } from './account.ts'
import { api, type SessionView } from './api.ts'
import { normalizeSession } from './shared/types.ts'

const POLL_MS = 4000

/** What someone else just changed (seen when polling), to tell the person looking. */
export type Changed = { what: 'roster' | 'setup'; at: number }

/** Loads a session and keeps it fresh by polling, so everyone sees each other's answers and the host's changes. */
export function useSession(code: string) {
  const [view, setView] = useState<SessionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState<Changed | null>(null)
  const version = useRef(-1)
  const last = useRef<{ roster: string; setup: string } | null>(null)

  const accept = useCallback((v: SessionView, byOthers = false) => {
    if (v.session.version >= version.current) {
      version.current = v.session.version
      const now = { roster: JSON.stringify(v.session.schedule ?? null), setup: JSON.stringify(v.session.config) }
      if (byOthers && last.current) {
        if (now.roster !== last.current.roster) setChanged({ what: 'roster', at: Date.now() })
        else if (now.setup !== last.current.setup) setChanged({ what: 'setup', at: Date.now() })
      }
      last.current = now
      setView({ ...v, session: normalizeSession(v.session) })
    }
    setError(null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const v = await api.get(code, version.current)
      if ('unchanged' in v) setError(null)
      else accept(v, true)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [code, accept])

  useEffect(() => {
    version.current = -1
    void refresh()
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    // Coming back to the tab or the window: the latest straight away, not up to POLL_MS later.
    const onShow = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('focus', onShow)
    // Signing in or out can change who you are here (host or not), so load everything again.
    const off = onAccountChange(() => {
      version.current = -1
      void refresh()
    })
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener('focus', onShow)
      off()
    }
  }, [refresh])

  /** Run a mutation and adopt the session it returns. */
  const mutate = useCallback(
    async (fn: () => Promise<SessionView>) => {
      const v = await fn()
      accept(v)
      return v
    },
    [accept],
  )

  return { view, error, refresh, mutate, changed, clearChanged: () => setChanged(null) }
}
