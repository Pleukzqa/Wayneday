import { useEffect, useState, type FormEvent } from 'react'
import { useAccount } from '../account.ts'
import { api, setTokens, type MySession } from '../api.ts'
import { GoogleButton } from '../components/GoogleButton.tsx'
import { googleClientId } from '../google.ts'
import { sessionHash } from '../routes.ts'
import { t } from '../shared/i18n.ts'

export default function Home() {
  const [title, setTitle] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const account = useAccount()
  // With Google set up, hosting needs a sign-in so the host can get back in from any device.
  const needSignIn = Boolean(googleClientId()) && !account

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.create(title.trim() || t('Duty roster'))
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
      setError(t('Codes look like three words, e.g. amber-otter-river.'))
      return
    }
    location.hash = sessionHash(c)
  }

  return (
    <div className="home">
      <section className="hero">
        <p className="hero-kicker">🩺 Wayneday · {t('Duty roster planner')}</p>
        <h1>{t('Fair duty rosters, without the group-chat chaos.')}</h1>
        <p className="muted">{t('Put in the hospital roster, let students mark the days they can’t make, and get a fair arrangement in a minute — then let everyone check it before it’s final.')}</p>
      </section>
      <ol className="how">
        <li>
          <span className="how-icon" aria-hidden>
            ⚙️
          </span>
          <strong>{t('Set up')}</strong>
          <span className="muted small">{t('Dates, shift slots, the hospital roster and the student list.')}</span>
        </li>
        <li>
          <span className="how-icon" aria-hidden>
            🗓️
          </span>
          <strong>{t('Everyone answers')}</strong>
          <span className="muted small">{t('Share the code. Students mark days they can’t or would rather not work.')}</span>
        </li>
        <li>
          <span className="how-icon" aria-hidden>
            ✨
          </span>
          <strong>{t('Arrange & agree')}</strong>
          <span className="muted small">{t('Pick the fairest option, publish for review, handle swaps, then finalize and export.')}</span>
        </li>
      </ol>
      <div className="home-grid">
        {needSignIn ? (
          <section className="card">
            <h2>🧑‍✈️ {t('Host a session')}</h2>
            <p className="muted small">{t('Sign in with Google to host. Your rosters then open on any device, and you can add co-hosts. Members don’t need Google — they join with the code and a PIN.')}</p>
            <GoogleButton />
          </section>
        ) : (
          <form className="card" onSubmit={create}>
            <h2>🧑‍✈️ {t('Host a session')}</h2>
            <label>
              {t('Roster name')}
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('e.g. Med ward — November')} />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? t('Creating…') : `✨ ${t('Create session')}`}
            </button>
          </form>
        )}
        <form className="card" onSubmit={join}>
          <h2>🙋 {t('Join a session')}</h2>
          <label>
            {t('Session code')}
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("amber-otter-river")} autoCapitalize="none" />
          </label>
          <button>{`➡️ ${t('Join')}`}</button>
        </form>
      </div>
      {error && <p className="error">{error}</p>}
      {account && <MyRosters />}
    </div>
  );
}

const STATUS: Record<MySession['status'], [string, string]> = {
  collecting: ['📝', 'collecting answers'],
  review: ['👀', 'roster in review'],
  final: ['✅', 'roster final'],
}

/** Sessions this Google account hosts or co-hosts. */
function MyRosters() {
  const [sessions, setSessions] = useState<MySession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .mySessions()
      .then((r) => setSessions(r.sessions))
      .catch((e: Error) => setError(e.message))
  }, [])
  return (
    <section className="card my-rosters">
      <h2>🗂️ {t('My rosters')}</h2>
      {error && <p className="error small">{error}</p>}
      {sessions && sessions.length === 0 && <p className="muted small">{t('Nothing yet — rosters you host or co-host show up here.')}</p>}
      {sessions && sessions.length > 0 && (
        <ul>
          {sessions.map((s) => (
            <li key={s.code}>
              <a href={sessionHash(s.code)}>
                <strong>{s.title}</strong>
              </a>
              <span className="muted small">
                {s.startDate} → {s.endDate} · {STATUS[s.status][0]} {t(STATUS[s.status][1])}
              </span>
              {s.role === 'cohost' && <span className="badge">{t('Co-host')}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
