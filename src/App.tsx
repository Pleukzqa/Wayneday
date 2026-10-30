import { useEffect, useState } from 'react'
import Home from './pages/Home.tsx'
import SessionPage from './pages/SessionPage.tsx'

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
  const code = /^#\/s\/([a-z]+-[a-z]+-[a-z]+)/.exec(hash)?.[1]
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="brand-mark" aria-hidden>
            ◷
          </span>
          Wayneday <span className="brand-sub">แอปจัดเวร</span>
        </a>
        {code && <span className="code-pill">{code}</span>}
      </header>
      <main className="page">{code ? <SessionPage key={code} code={code} /> : <Home />}</main>
    </>
  )
}
