import { lazy, Suspense, useEffect, useState } from 'react'
import Home from './pages/Home.tsx'
import SessionPage from './pages/SessionPage.tsx'
import { codeFromHash, IS_DEMO } from './routes.ts'
import { setLang, t, type Lang } from './shared/i18n.ts'
import { AccountChip } from './components/GoogleButton.tsx'
import Logo from './components/Logo.tsx'
import { useAppUpdate } from './appUpdate.ts'

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

type Theme = 'auto' | 'light' | 'dark'
const THEMES: Theme[] = ['auto', 'light', 'dark']
const THEME_ICON: Record<Theme, string> = { auto: '🌓', light: '☀️', dark: '🌙' }
const THEME_LABEL: Record<Theme, string> = { auto: 'Theme: like this device', light: 'Theme: light', dark: 'Theme: dark' }

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('wayneday:theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // no storage: follow the device
  }
  return 'auto'
}

/** Light or dark regardless of the device; "auto" follows it. index.html applies the saved one before the first paint. */
function applyTheme(theme: Theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
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
  const update = useAppUpdate()
  const [theme, setTheme] = useState<Theme>(initialTheme)
  useEffect(() => applyTheme(theme), [theme])
  const nextTheme = () => {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]
    setTheme(next)
    try {
      if (next === 'auto') localStorage.removeItem('wayneday:theme')
      else localStorage.setItem('wayneday:theme', next)
    } catch {
      // this tab only
    }
  }
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
          <Logo />
          Wayneday <span className="brand-sub">{t('Duty roster planner')}</span>
        </a>
        <div className="topbar-right">
          {code && <span className="code-pill">{code}</span>}
          <AccountChip />
          <button type="button" className="theme-switch" onClick={nextTheme} title={t(THEME_LABEL[theme])} aria-label={t(THEME_LABEL[theme])}>
            {THEME_ICON[theme]}
          </button>
          <div className="segmented lang" role="radiogroup" aria-label="Language / ภาษา">
            {(['th', 'en'] as const).map((l) => (
              <button key={l} role="radio" aria-checked={lang === l} className={lang === l ? 'on' : ''} onClick={() => switchLang(l)}>
                {l === 'th' ? 'ไทย' : 'EN'}
              </button>
            ))}
          </div>
        </div>
      </header>
      {update && (
        <div className="update-bar" role="status">
          🆕 {t('A new version of Wayneday is out — it loads as soon as your changes are saved.')}{' '}
          <button type="button" onClick={() => location.reload()}>
            {t('Reload now')}
          </button>
        </div>
      )}
      <main className="page">
        {code ? <SessionPage key={`${code}:${viewer}`} code={code} /> : <Home />}
        <footer className="site-footer">
          🩺 {t('Made by Pleuk MDCU78')}
          {!IS_DEMO && (
            <>
              {' · '}
              <a href="/guide.html">{t('How to use')}</a>
              {' · '}
              <a href="/privacy.html">{t('Privacy')}</a>
            </>
          )}
          <div className="build" title={t('Built {date}', { date: __BUILD__.date })}>
            {t('Version')} {__BUILD__.commit || 'dev'} · {new Date(__BUILD__.date).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' })}
          </div>
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
