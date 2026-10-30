import { lazy, Suspense, useEffect, useState } from 'react'
import Home from './pages/Home.tsx'
import SessionPage from './pages/SessionPage.tsx'
import { codeFromHash, IS_DEMO } from './routes.ts'
import { setLang, t, type Lang } from './shared/i18n.ts'
import { AccountChip } from './components/GoogleButton.tsx'

// Only bundled into the phone demo build.
const DemoBar = IS_DEMO ? lazy(() => import('./demo/DemoBar.tsx')) : null

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('wayneday:lang')
    if (saved === 'th' || saved === 'en') return saved
  } catch {
    // no storage: fall through
  }
  return navigator.language.toLowerCase().startsWith('th') ? 'th' : 'en'
}

function useHash() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash
}

export default function App() {
  const hash = useHash()
  const code = codeFromHash(hash)
  // Bumped by the demo's identity switcher to reload the session as someone else.
  const [viewer, setViewer] = useState(0)
  const [lang, setLangState] = useState<Lang>(initialLang)
  setLang(lang)
  useEffect(() => {
    document.documentElement.lang = lang
    document.title = `Wayneday — ${t('Duty roster planner')}`
  }, [lang])
  const switchLang = (l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem('wayneday:lang', l)
    } catch {
      // this tab only
    }
  }
  return (
    <>
      <header className="topbar">
        <a href="#home" className="brand">
          <span className="brand-mark" aria-hidden>
            ◷
          </span>
          Wayneday <span className="brand-sub">{t('Duty roster planner')}</span>
        </a>
        <div className="topbar-right">
          {code && <span className="code-pill">{code}</span>}
          <AccountChip />
          <div className="segmented lang" role="radiogroup" aria-label="Language / ภาษา">
            {(['th', 'en'] as const).map((l) => (
              <button key={l} role="radio" aria-checked={lang === l} className={lang === l ? 'on' : ''} onClick={() => switchLang(l)}>
                {l === 'th' ? 'ไทย' : 'EN'}
              </button>
            ))}
          </div>
        </div>
      </header>
      <main className="page">
        {code ? <SessionPage key={`${code}:${viewer}`} code={code} /> : <Home />}
        <footer className="site-footer">
          🩺 {t('Made by Pleuk MDCU78')}
          {!IS_DEMO && (
            <>
              {' · '}
              <a href="/privacy.html">{t('Privacy')}</a>
            </>
          )}
        </footer>
      </main>
      {DemoBar && (
        <Suspense fallback={null}>
          <DemoBar code={code} onSwitch={() => setViewer((v) => v + 1)} />
        </Suspense>
      )}
    </>
  )
}
