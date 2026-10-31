// A table that can fill the whole screen. Done in the page (not the browser's fullscreen mode), since iPhones only
// allow that for videos. Esc or "Close" goes back.
import { useEffect, useState, type ReactNode } from 'react'
import { t } from '../shared/i18n.ts'

export default function Expandable({ children, title }: { children: ReactNode; title?: string }) {
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false)
    window.addEventListener('keydown', onKey)
    document.body.classList.add('no-scroll')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.classList.remove('no-scroll')
    }
  }, [full])
  return (
    <div className={`expandable ${full ? 'full' : ''}`} role={full ? 'dialog' : undefined} aria-label={full ? title : undefined}>
      <div className="expand-bar">
        {full && title && <strong>{title}</strong>}
        <button type="button" className={full ? 'primary' : 'link small'} onClick={() => setFull(!full)}>
          {full ? `✕ ${t('Close full screen')}` : `⛶ ${t('Full screen')}`}
        </button>
      </div>
      {children}
    </div>
  )
}
