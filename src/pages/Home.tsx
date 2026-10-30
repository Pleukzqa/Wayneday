import { useState, type FormEvent } from 'react'
import { api, setTokens } from '../api.ts'
import { sessionHash } from '../routes.ts'
import { t } from '../shared/i18n.ts'

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
        <p className="hero-kicker">{t("🩺 Wayneday · แอปจัดเวร")}</p>
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
    </div>
  );
}
