// Unsaved work on this page (a setup draft, roster edits, answers not sent yet). A new version of the app reloads
// the page by itself only when there's none, so nothing is lost.
import { useEffect } from 'react'

const parts = new Set<string>()

export const hasUnsaved = () => parts.size > 0

/** While `on`, this part of the page has unsaved work. */
export function useUnsaved(key: string, on: boolean) {
  useEffect(() => {
    if (on) parts.add(key)
    else parts.delete(key)
    return () => {
      parts.delete(key)
    }
  }, [key, on])
}
