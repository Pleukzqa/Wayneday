import { lazy, Suspense, useEffect, useState } from 'react'
import Home from './pages/Home.tsx'
import SessionPage from './pages/SessionPage.tsx'
import { codeFromHash, IS_DEMO } from './routes.ts'

// Only bundled into the phone demo build.
const DemoBar = IS_DEMO ? lazy(() => import('./demo/DemoBar.tsx')) : null

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
  return (
    <>
      <header className="topbar">
        <a href="#home" className="brand">
          <span className="brand-mark" aria-hidden>
            ◷
          </span>
          Wayneday <span className="brand-sub">แอปจัดเวร</span>
        </a>
        {code && <span className="code-pill">{code}</span>}
      </header>
      <main className="page">{code ? <SessionPage key={`${code}:${viewer}`} code={code} /> : <Home />}</main>
      {DemoBar && (
        <Suspense fallback={null}>
          <DemoBar code={code} onSwitch={() => setViewer((v) => v + 1)} />
        </Suspense>
      )}
    </>
  )
}
