import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type SessionView } from './api.ts'
import { normalizeSession } from './shared/types.ts'

const POLL_MS = 4000

/** Loads a session and keeps it fresh by polling, so everyone sees each other's answers. */
export function useSession(code: string) {
  const [view, setView] = useState<SessionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const version = useRef(-1)

  const accept = useCallback((v: SessionView) => {
    if (v.session.version >= version.current) {
      version.current = v.session.version
      setView({ ...v, session: normalizeSession(v.session) })
    }
    setError(null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      accept(await api.get(code))
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
    return () => clearInterval(t)
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

  return { view, error, refresh, mutate }
}
