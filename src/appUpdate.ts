// A new version of Wayneday (a deploy) serves a new script: notice it, and reload the page when nothing unsaved
// would be lost — otherwise say so and let the person reload when they're ready.
import { useEffect, useState } from 'react'
import { hasUnsaved } from './unsaved.ts'

const CHECK_MS = 60_000
const script = (html: string) => html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1] ?? null

export function useAppUpdate(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    // Only the built app has a hashed script to compare (not the dev server or the one-page demo).
    const mine = document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src') ?? null
    if (!mine) return
    const check = async () => {
      try {
        const latest = script(await (await fetch('/', { cache: 'no-store' })).text())
        if (latest && latest !== mine) setReady(true)
      } catch {
        // offline: try again later
      }
    }
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void check()
    }, CHECK_MS)
    const onShow = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onShow)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [])
  // Reload as soon as nothing unsaved is on the page (checked again every few seconds while there is).
  useEffect(() => {
    if (!ready) return
    const go = () => {
      if (!hasUnsaved()) location.reload()
    }
    go()
    const t = setInterval(go, 5000)
    return () => clearInterval(t)
  }, [ready])
  return ready
}
