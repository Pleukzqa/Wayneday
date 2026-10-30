import { useState, type FormEvent } from 'react'
import { api, setTokens } from '../api.ts'
import { sessionHash } from '../routes.ts'

export default function Home() {
  const [title, setTitle] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.create(title.trim() || 'Duty roster')
      setTokens(r.code, { hostToken: r.hostToken })
      location.hash = sessionHash(r.code)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function join(e: FormEvent) {
    e.preventDefault()
    const c = code.trim().toLowerCase().replace(/\s+/g, '-')
    if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(c)) {
      setError('Codes look like three words, e.g. amber-otter-river.')
      return
    }
    location.hash = sessionHash(c)
  }

  return (
    <div className="home">
      <section className="hero">
        <h1>Fair duty rosters, agreed by the whole team.</h1>
        <p className="muted">
          The host sets up shifts and people. Everyone logs in with the session code to mark the dates they can't work,
          lock dates they want, and choose spread-out or grouped shifts. The host simulates, then publishes the roster
          for a review period before it's final.
        </p>
      </section>
      <div className="home-grid">
        <form className="card" onSubmit={create}>
          <h2>Host a session</h2>
          <label>
            Roster name
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Med ward — November" />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create session'}
          </button>
        </form>
        <form className="card" onSubmit={join}>
          <h2>Join a session</h2>
          <label>
            Session code
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="amber-otter-river" autoCapitalize="none" />
          </label>
          <button>Join</button>
        </form>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
